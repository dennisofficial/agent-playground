import { describe, expect, it } from 'vitest';
import { InMemoryRedisStream } from '../../_lib/redis/in-memory-redis-stream';
import { drainTurnEventConsumer } from './turn-event-consumer';

const STREAM = 'turn:T:events';

/** Append a batch of `{ n }` frames to the events stream, returning their ids. */
async function seed(redis: InMemoryRedisStream, values: number[]): Promise<string[]> {
  const ids: string[] = [];
  for (const n of values) ids.push(await redis.xadd(STREAM, { n }));
  return ids;
}

describe('drainTurnEventConsumer', () => {
  it('delivers entries in order and acks them', async () => {
    const redis = new InMemoryRedisStream();
    await seed(redis, [1, 2, 3]);

    const seen: number[] = [];
    const done = { value: false };
    await drainTurnEventConsumer({
      redis,
      stream: STREAM,
      group: 'g1',
      consumer: 'c1',
      blockMs: 20,
      isDone: () => done.value,
      onEntry: (entry) => {
        const n = (entry.data as { n: number }).n;
        seen.push(n);
        return n === 3; // stop after the last frame
      },
    });

    expect(seen).toEqual([1, 2, 3]);
    // Everything acked ⇒ nothing left to reclaim on a fresh claimStale.
    const stranded = await redis.claimStale({
      group: 'g1',
      consumer: 'c2',
      stream: STREAM,
      minIdleMs: 0,
      count: 16,
    });
    expect(stranded).toEqual([]);
  });

  it('reclaims a stale/pending entry left by a dead consumer once at start', async () => {
    const redis = new InMemoryRedisStream();
    await seed(redis, [1, 2]);

    // Simulate a dead consumer: it read the two entries via the group but never acked them.
    await redis.ensureGroup(STREAM, 'g1');
    const delivered = await redis.xreadGroup({
      group: 'g1',
      consumer: 'dead',
      stream: STREAM,
      count: 16,
      blockMs: 5,
    });
    expect(delivered.map((e) => (e.data as { n: number }).n)).toEqual([1, 2]);

    // A fresh consumer in the SAME group must reclaim those un-acked entries at start.
    const seen: number[] = [];
    await drainTurnEventConsumer({
      redis,
      stream: STREAM,
      group: 'g1',
      consumer: 'fresh',
      blockMs: 20,
      isDone: () => false,
      onEntry: (entry) => {
        const n = (entry.data as { n: number }).n;
        seen.push(n);
        return n === 2; // stop once both reclaimed entries are drained
      },
    });

    expect(seen).toEqual([1, 2]);
  });

  it('two independent groups on the same stream each see the FULL sequence independently', async () => {
    const redis = new InMemoryRedisStream();
    await seed(redis, [1, 2, 3]);

    const runLoop = async (group: string): Promise<number[]> => {
      const seen: number[] = [];
      await drainTurnEventConsumer({
        redis,
        stream: STREAM,
        group,
        consumer: `${group}-1`,
        blockMs: 20,
        isDone: () => false,
        onEntry: (entry) => {
          const n = (entry.data as { n: number }).n;
          seen.push(n);
          return n === 3;
        },
      });
      return seen;
    };

    // Group A fully drains FIRST. Because a consumer group tracks its OWN server-side cursor + PEL, and
    // draining/acking never removes entries from the shared stream, group B must still observe every entry.
    const a = await runLoop('groupA');
    const b = await runLoop('groupB');

    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([1, 2, 3]);
  });
});
