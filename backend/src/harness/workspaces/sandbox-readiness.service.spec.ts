/**
 * Phase 10 (host half) — `SandboxReadinessService` unit tests against the in-memory Redis fake (NO
 * live Redis). The daemon's `DaemonReadinessService` XADDs a durable `ReadyFrame` to `ws:{id}:ready`;
 * this service is the host consumer that gates the first turn on it. Covers:
 *   - resolves when the marker is ALREADY present (durable — written before we asked);
 *   - BLOCKS until the marker arrives, then resolves;
 *   - readies even when the daemon signaled `innerDocker:false` (bounded daemon-side fallback);
 *   - CACHES — only the FIRST turn reads the stream; later turns return without an XREAD;
 *   - forget() drops the cache so the next turn re-waits;
 *   - throws a CLEAR, bounded error when the marker never appears;
 *   - is RESILIENT to a transient Redis error (caught + retried within the deadline, then resolves;
 *     a persistently-broken Redis surfaces as the bounded clear error, not a raw connection error).
 */
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRedisStream } from '../../_lib/redis/in-memory-redis-stream';
import type { RedisStreamPort } from '../../_lib/redis/redis.port';
import { readyKey, type ReadyFrame } from './daemon-protocol';
import { SandboxReadinessService } from './sandbox-readiness.service';

const WS = 'sandbox-uuid-123';

function readyFrame(innerDocker = true): ReadyFrame {
  return { ready: true, innerDocker, at: 0 };
}

describe('SandboxReadinessService.waitForReady', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('resolves immediately when the marker is already present (durable)', async () => {
    const redis = new InMemoryRedisStream();
    await redis.xadd(readyKey(WS), readyFrame(true));
    const svc = new SandboxReadinessService(redis);

    await expect(svc.waitForReady(WS)).resolves.toBeUndefined();
  });

  it('blocks until the marker arrives, then resolves', async () => {
    const redis = new InMemoryRedisStream();
    const svc = new SandboxReadinessService(redis);

    let resolved = false;
    const wait = svc.waitForReady(WS).then(() => {
      resolved = true;
    });
    // Give the XREAD a tick to park on the (empty) stream — it must NOT have resolved yet.
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);

    // The daemon writes its marker → the blocked XREAD wakes and the wait resolves.
    await redis.xadd(readyKey(WS), readyFrame(true));
    await wait;
    expect(resolved).toBe(true);
  });

  it('readies even when the daemon signaled innerDocker:false', async () => {
    const redis = new InMemoryRedisStream();
    await redis.xadd(readyKey(WS), readyFrame(false));
    const svc = new SandboxReadinessService(redis);

    // The host's job is to wait for the marker; the daemon already decided to proceed without inner
    // Docker after its own ceiling, so a `false` marker still gates through.
    await expect(svc.waitForReady(WS)).resolves.toBeUndefined();
  });

  it('caches: only the FIRST turn reads the stream', async () => {
    const redis = new InMemoryRedisStream();
    await redis.xadd(readyKey(WS), readyFrame());
    const xread = vi.spyOn(redis, 'xread');
    const svc = new SandboxReadinessService(redis);

    await svc.waitForReady(WS);
    await svc.waitForReady(WS);
    await svc.waitForReady(WS);

    expect(xread).toHaveBeenCalledTimes(1); // confirmed once; every later turn is a cache hit
  });

  it('forget() drops the cache so the next turn re-waits', async () => {
    const redis = new InMemoryRedisStream();
    await redis.xadd(readyKey(WS), readyFrame());
    const xread = vi.spyOn(redis, 'xread');
    const svc = new SandboxReadinessService(redis);

    await svc.waitForReady(WS);
    svc.forget(WS);
    await svc.waitForReady(WS);

    expect(xread).toHaveBeenCalledTimes(2); // re-read after forget
  });

  it('throws a clear, bounded error when the marker never appears', async () => {
    const redis = new InMemoryRedisStream();
    const svc = new SandboxReadinessService(redis);

    await expect(svc.waitForReady(WS, 50)).rejects.toThrow(
      new RegExp(`${WS} did not signal ready within 50ms`),
    );
  });

  it('does NOT cache a failed wait — the next turn re-attempts and can succeed', async () => {
    const redis = new InMemoryRedisStream();
    const svc = new SandboxReadinessService(redis);

    await expect(svc.waitForReady(WS, 50)).rejects.toThrow(/did not signal ready/);

    // The marker shows up later; a fresh wait now succeeds (the failure wasn't cached).
    await redis.xadd(readyKey(WS), readyFrame());
    await expect(svc.waitForReady(WS)).resolves.toBeUndefined();
  });

  it('surfaces a persistently-broken Redis as the bounded clear error (not a raw error)', async () => {
    const broken = {
      xread: vi.fn(() => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:6379'))),
    } as unknown as RedisStreamPort;
    const svc = new SandboxReadinessService(broken);

    // The transient-error path is exercised on every loop; only the bounded deadline ends it, and it
    // ends with OUR clear message — the raw ECONNREFUSED never escapes.
    await expect(svc.waitForReady(WS, 40)).rejects.toThrow(/did not signal ready within 40ms/);
    expect(broken.xread).toHaveBeenCalled();
  });

  it('is resilient to a transient Redis error: retries and resolves once the marker is present', async () => {
    vi.useFakeTimers();
    try {
      const redis = new InMemoryRedisStream();
      await redis.xadd(readyKey(WS), readyFrame());
      let calls = 0;
      const flaky = {
        xread: (args: Parameters<RedisStreamPort['xread']>[0]) => {
          calls += 1;
          // First read fails (lazy client mid-connect); the retry hits the present marker.
          return calls === 1
            ? Promise.reject(new Error('ECONNREFUSED'))
            : redis.xread(args);
        },
      } as unknown as RedisStreamPort;
      const svc = new SandboxReadinessService(flaky);

      const wait = svc.waitForReady(WS);
      // Flush the rejected read + catch, fast-forward the back-off sleep → the retry resolves.
      await vi.runAllTimersAsync();
      await expect(wait).resolves.toBeUndefined();
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates concurrent first-turns into ONE wait', async () => {
    const redis = new InMemoryRedisStream();
    await redis.xadd(readyKey(WS), readyFrame());
    const xread = vi.spyOn(redis, 'xread');
    const svc = new SandboxReadinessService(redis);

    await Promise.all([
      svc.waitForReady(WS),
      svc.waitForReady(WS),
      svc.waitForReady(WS),
    ]);

    expect(xread).toHaveBeenCalledTimes(1); // the three callers shared one in-flight XREAD loop
  });
});
