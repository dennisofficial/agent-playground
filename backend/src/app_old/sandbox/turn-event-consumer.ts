import type { RedisStreamPort, StreamEntry } from '../../_lib/redis/redis.port';

export interface TurnEventConsumerOptions {
  redis: RedisStreamPort;
  stream: string;
  group: string;
  consumer: string;
  count?: number; // default 16
  blockMs?: number; // default 1000
  onEntry: (entry: StreamEntry) => boolean | Promise<boolean>;
  isDone: () => boolean;
}

export async function drainTurnEventConsumer(opts: TurnEventConsumerOptions): Promise<void> {
  const { redis, stream, group, consumer, onEntry, isDone } = opts;
  const count = opts.count ?? 16;
  const blockMs = opts.blockMs ?? 1000;

  await redis.ensureGroup(stream, group);

  let claimedPending = false;
  while (!isDone()) {
    try {
      const pending = claimedPending
        ? []
        : await redis.claimStale({
            group,
            consumer,
            stream,
            minIdleMs: 0,
            count,
          });
      claimedPending = true;
      const fresh = await redis.xreadGroup({
        group,
        consumer,
        stream,
        count,
        blockMs,
      });
      for (const entry of [...pending, ...fresh]) {
        const stop = await onEntry(entry);
        await redis.ack(stream, group, [entry.id]);
        if (stop) return;
      }
    } catch {
      claimedPending = false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
