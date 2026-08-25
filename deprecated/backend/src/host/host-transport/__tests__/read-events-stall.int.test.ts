import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { turnKeys } from '../../../_shared/engine/redis-turn-keys';
import { HostTransportService, TurnStalledError } from '../host-transport.service';

// readEvents must distinguish a dead engine (no events at all) from a healthy-but-quiet one (heartbeats keep
// coming). Real Redis — the blocking XREAD + timer behavior can't be mocked meaningfully.
describe('readEvents stall (int)', () => {
  let redis: Redis;
  let host: HostTransportService;
  const turnIds: string[] = [];

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
    host = new HostTransportService(redis);
  });

  afterAll(async () => {
    if (turnIds.length) await redis.del(...turnIds.map((t) => turnKeys(t).events));
    redis.disconnect();
  });

  const freshTurn = (): string => {
    const id = randomUUID();
    turnIds.push(id);
    return id;
  };

  const emit = (turnId: string, event: unknown) =>
    redis.xadd(turnKeys(turnId).events, '*', 'data', JSON.stringify(event));

  it('throws TurnStalledError when no event arrives within the stall window', async () => {
    const turnId = freshTurn();
    const drain = (async () => {
      for await (const _ of host.readEvents(turnId, 300)) void _;
    })();
    await expect(drain).rejects.toBeInstanceOf(TurnStalledError);
  });

  it('does not stall while events (e.g. heartbeats) keep arriving', async () => {
    const turnId = freshTurn();
    const beat = setInterval(() => void emit(turnId, { type: 'heartbeat' }), 150);
    try {
      const got: unknown[] = [];
      for await (const event of host.readEvents(turnId, 500)) {
        got.push(event);
        if (got.length >= 4) break; // ~600ms of beats at 150ms each — well past the 500ms stall window
      }
      expect(got.length).toBeGreaterThanOrEqual(4);
    } finally {
      clearInterval(beat);
    }
  });
});
