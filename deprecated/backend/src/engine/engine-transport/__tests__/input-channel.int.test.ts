import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { turnKeys } from '../../../_shared/engine/redis-turn-keys';
import { HostTransportService } from '../../../host/host-transport/host-transport.service';
import { EngineTransportService } from '../engine-transport.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The mid-turn steering channel is real Redis behavior — blocking XREAD on a dedicated connection, torn down by an
// abort. A mock can't exercise that, so this runs against local Redis (REDIS_URL from .env.test).
describe('input channel (int)', () => {
  let redis: Redis;
  let host: HostTransportService;
  let engine: EngineTransportService;
  const turnIds: string[] = [];

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
    host = new HostTransportService(redis);
    engine = new EngineTransportService(redis);
  });

  afterAll(async () => {
    if (turnIds.length) await redis.del(...turnIds.map((t) => turnKeys(t).input));
    redis.disconnect();
  });

  const freshTurn = (): string => {
    const id = randomUUID();
    turnIds.push(id);
    return id;
  };

  it('delivers host-written steering frames to the engine reader, in order (with priority)', async () => {
    const turnId = freshTurn();
    await host.writeInput(turnId, { text: 'first', priority: 'next' });
    await host.writeInput(turnId, { text: 'second' });

    const ac = new AbortController();
    const got: Array<{ text: string; priority?: string }> = [];
    for await (const frame of engine.readInput(turnId, ac.signal)) {
      got.push(frame);
      if (got.length === 2) ac.abort(); // stop once we've drained what we wrote
    }

    expect(got).toEqual([{ text: 'first', priority: 'next' }, { text: 'second' }]);
  });

  it('picks up a frame written after the reader is already blocked', async () => {
    const turnId = freshTurn();
    const ac = new AbortController();
    const got: Array<{ text: string }> = [];
    const consume = (async () => {
      for await (const frame of engine.readInput(turnId, ac.signal)) {
        got.push(frame);
        ac.abort();
      }
    })();

    await sleep(50); // let the reader enter its blocking XREAD first
    await host.writeInput(turnId, { text: 'late' });
    await consume;

    expect(got).toEqual([{ text: 'late' }]);
  });

  it('a blocked reader unblocks and returns promptly on abort (no message)', async () => {
    const turnId = freshTurn();
    const ac = new AbortController();
    const done = (async () => {
      for await (const _ of engine.readInput(turnId, ac.signal)) void _;
    })();

    await sleep(50);
    ac.abort();
    // disconnect() unblocks the in-flight read immediately — well under the 1s block window.
    await expect(Promise.race([done, sleep(500).then(() => 'timeout')])).resolves.toBeUndefined();
  });
});
