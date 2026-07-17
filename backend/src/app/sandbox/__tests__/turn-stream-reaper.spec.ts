import { describe, expect, it, vi } from 'vitest';
import { TurnStreamReaperService } from '../turn-stream-reaper.service';
import { turnKeys } from '../redis-turn-keys';
import { InMemoryRedisStream } from '../../../_lib/redis/in-memory-redis-stream';
import type { TurnRegistry } from '../turn-registry.service';
import type { LeaderElectionService } from '../cluster/leader-election.service';
import type { EnvService } from '@core/config/env/env.service';

const env = (vals: Record<string, unknown> = {}) =>
  ({ get: (k: string) => vals[k] }) as unknown as EnvService;
const election = {} as unknown as LeaderElectionService;

/** Seed a turn's spec+events streams into the fake and return its key list. */
const seedTurn = (redis: InMemoryRedisStream, turnId: string): string[] => {
  const k = turnKeys(turnId);
  void redis.xadd(k.spec, { turnId });
  void redis.xadd(k.events, { t: 'event' });
  return [k.spec, k.events];
};

const reaper = (
  redis: InMemoryRedisStream,
  registry: TurnRegistry,
  idleMs = 300_000,
) =>
  new TurnStreamReaperService(
    redis,
    registry,
    election,
    env({ TURN_STREAM_REAP_IDLE_MS: idleMs }),
  );

describe('TurnStreamReaperService.reap', () => {
  it('deletes the streams of an orphan turn (no active_turns row) idle past the floor', async () => {
    const redis = new InMemoryRedisStream();
    const keys = seedTurn(redis, 'orphan-1');
    keys.forEach((key) => redis.setKeyIdleForTest(key, 600)); // idle 10min > 5min floor

    const registry = {
      allTurnIds: vi.fn(async () => new Set<string>()),
    } as unknown as TurnRegistry;
    await reaper(redis, registry).reap();

    for (const key of keys) expect(await redis.objectIdleTime(key)).toBeNull(); // gone
  });

  it('never touches a live turn — its id is in active_turns — even when idle', async () => {
    const redis = new InMemoryRedisStream();
    const keys = seedTurn(redis, 'live-1');
    keys.forEach((key) => redis.setKeyIdleForTest(key, 600));

    const registry = {
      allTurnIds: vi.fn(async () => new Set(['live-1'])),
    } as unknown as TurnRegistry;
    await reaper(redis, registry).reap();

    for (const key of keys)
      expect(await redis.objectIdleTime(key)).not.toBeNull(); // kept
  });

  it('spares an orphan still within the idle floor (mid-registration safety)', async () => {
    const redis = new InMemoryRedisStream();
    const keys = seedTurn(redis, 'fresh-1'); // just xadded → idle ~0

    const registry = {
      allTurnIds: vi.fn(async () => new Set<string>()),
    } as unknown as TurnRegistry;
    await reaper(redis, registry).reap();

    for (const key of keys)
      expect(await redis.objectIdleTime(key)).not.toBeNull(); // kept
  });

  it('reaps orphans while sparing live + fresh turns in one pass', async () => {
    const redis = new InMemoryRedisStream();
    const orphan = seedTurn(redis, 'orphan-2');
    const live = seedTurn(redis, 'live-2');
    const fresh = seedTurn(redis, 'fresh-2');
    [...orphan, ...live].forEach((key) => redis.setKeyIdleForTest(key, 600));

    const registry = {
      allTurnIds: vi.fn(async () => new Set(['live-2'])),
    } as unknown as TurnRegistry;
    await reaper(redis, registry).reap();

    for (const key of orphan)
      expect(await redis.objectIdleTime(key)).toBeNull();
    for (const key of [...live, ...fresh])
      expect(await redis.objectIdleTime(key)).not.toBeNull();
  });

  it('a registry failure is swallowed — nothing is deleted, never throws', async () => {
    const redis = new InMemoryRedisStream();
    const keys = seedTurn(redis, 'orphan-3');
    keys.forEach((key) => redis.setKeyIdleForTest(key, 600));

    const registry = {
      allTurnIds: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as TurnRegistry;

    await expect(reaper(redis, registry).reap()).resolves.toBeUndefined();
    for (const key of keys)
      expect(await redis.objectIdleTime(key)).not.toBeNull(); // untouched
  });
});
