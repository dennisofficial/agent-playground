import { describe, expect, it, vi } from 'vitest';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TurnWatchdogService } from './turn-watchdog.service';
import { turnKeys } from './redis-turn-keys';
import type { TurnRegistry } from './turn-registry.service';
import type { LeaderElectionService } from '../cluster';
import type { EnvService } from '@core/config/env/env.service';
import type { RedisStreamPort } from '../../_lib/redis/redis.port';
import type { ActiveTurnEntity } from '../persistence/entities';

const env = (vals: Record<string, unknown> = {}) =>
  ({ get: (k: string) => vals[k] }) as unknown as EnvService;
const election = {} as unknown as LeaderElectionService;

/** A redis whose per-key OBJECT IDLETIME is scripted (null = key missing = engine left no trace). */
const redisWithIdle = (idleByKey: Record<string, number | null> = {}) =>
  ({
    objectIdleTime: vi.fn(async (key: string) => idleByKey[key] ?? null),
  }) as unknown as RedisStreamPort & { objectIdleTime: ReturnType<typeof vi.fn> };

describe('TurnWatchdogService.sweep', () => {
  it('finalizes every stale turn as failed', async () => {
    const registry = {
      findStale: vi.fn(async () => [
        { turn_id: 't1', job_id: 'th1' },
        { turn_id: 't2', job_id: 'th2' },
      ] as ActiveTurnEntity[]),
      finalize: vi.fn(async () => undefined),
    } as unknown as TurnRegistry & { findStale: ReturnType<typeof vi.fn>; finalize: ReturnType<typeof vi.fn> };

    await new TurnWatchdogService(registry, election, env({ TURN_STALE_MS: 5000 }), redisWithIdle()).sweep();

    expect(registry.findStale).toHaveBeenCalledWith(5000);
    expect(registry.finalize).toHaveBeenCalledTimes(2);
    expect(registry.finalize).toHaveBeenCalledWith('t1', 'failed');
    expect(registry.finalize).toHaveBeenCalledWith('t2', 'failed');
  });

  it('spares a DB-stale turn whose events stream is recently active (alive but unattached), freshening its heartbeat', async () => {
    const registry = {
      findStale: vi.fn(async () => [
        { turn_id: 't-live', job_id: 'th1' },
        { turn_id: 't-dead', job_id: 'th2' },
      ] as ActiveTurnEntity[]),
      finalize: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => undefined),
    } as unknown as TurnRegistry & {
      finalize: ReturnType<typeof vi.fn>;
      heartbeat: ReturnType<typeof vi.fn>;
    };
    // t-live's engine wrote 3s ago (in-container heartbeats keep flowing without any attached host);
    // t-dead's stream has been idle for 10 minutes (its 5s heartbeat writer is gone → container died).
    const redis = redisWithIdle({
      [turnKeys('t-live').events]: 3,
      [turnKeys('t-dead').events]: 600,
    });

    await new TurnWatchdogService(registry, election, env(), redis).sweep();

    expect(registry.finalize).toHaveBeenCalledTimes(1);
    expect(registry.finalize).toHaveBeenCalledWith('t-dead', 'failed');
    expect(registry.heartbeat).toHaveBeenCalledWith('t-live'); // leaves the stale set until re-attach
  });

  it('a liveness-probe failure falls back to finalizing (fail towards cleanup, as before)', async () => {
    const registry = {
      findStale: vi.fn(async () => [{ turn_id: 't1', job_id: 'th1' }] as ActiveTurnEntity[]),
      finalize: vi.fn(async () => undefined),
    } as unknown as TurnRegistry & { finalize: ReturnType<typeof vi.fn> };
    const redis = {
      objectIdleTime: vi.fn(async () => {
        throw new Error('redis down');
      }),
    } as unknown as RedisStreamPort;

    await new TurnWatchdogService(registry, election, env(), redis).sweep();

    expect(registry.finalize).toHaveBeenCalledWith('t1', 'failed');
  });

  it('uses the default stale window when TURN_STALE_MS is unset, and no-ops on an empty sweep', async () => {
    const registry = {
      findStale: vi.fn(async () => [] as ActiveTurnEntity[]),
      finalize: vi.fn(async () => undefined),
    } as unknown as TurnRegistry & { findStale: ReturnType<typeof vi.fn>; finalize: ReturnType<typeof vi.fn> };

    await new TurnWatchdogService(registry, election, env(), redisWithIdle()).sweep();

    expect(registry.findStale).toHaveBeenCalledWith(90_000); // default
    expect(registry.finalize).not.toHaveBeenCalled();
  });

  it('a findStale failure is swallowed (the sweep retries next tick, never throws)', async () => {
    const registry = {
      findStale: vi.fn(async () => {
        throw new Error('db down');
      }),
      finalize: vi.fn(async () => undefined),
    } as unknown as TurnRegistry & { findStale: ReturnType<typeof vi.fn>; finalize: ReturnType<typeof vi.fn> };

    await expect(
      new TurnWatchdogService(registry, election, env(), redisWithIdle()).sweep(),
    ).resolves.toBeUndefined();
    expect(registry.finalize).not.toHaveBeenCalled();
  });
});

describe('TurnWatchdogService boot grace', () => {
  it('touches every running heartbeat BEFORE the first sweep on leader promotion', async () => {
    const order: string[] = [];
    const registry = {
      touchAllRunningHeartbeats: vi.fn(async () => {
        order.push('touch');
      }),
      findStale: vi.fn(async () => {
        order.push('sweep');
        return [];
      }),
      finalize: vi.fn(async () => undefined),
    } as unknown as TurnRegistry;

    let promote = () => {};
    const promotableElection = {
      onPromote: (cb: () => void) => {
        promote = cb;
        return { unsubscribe() {} };
      },
      onDemote: () => ({ unsubscribe() {} }),
    } as unknown as LeaderElectionService;

    // A REAL SchedulerRegistry so the leader-gated interval registers + fires (start() no-ops without one).
    const svc = new TurnWatchdogService(
      registry,
      promotableElection,
      env(),
      redisWithIdle(),
      new SchedulerRegistry(),
    );
    svc.onApplicationBootstrap(); // subscribes (not a *_test DB → watchdog on)
    promote(); // fire start()
    await new Promise((r) => setTimeout(r, 20)); // let the touch().finally(sweep) chain settle
    svc.onApplicationShutdown(); // clear the interval

    // The grace touch runs first, so a turn whose heartbeat froze across a restart survives the first sweep.
    expect(order).toEqual(['touch', 'sweep']);
  });
});
