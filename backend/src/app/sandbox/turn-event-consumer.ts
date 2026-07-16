import type { RedisStreamPort, StreamEntry } from '../../_lib/redis/redis.port';

export interface TurnEventConsumerOptions {
  redis: RedisStreamPort;
  stream: string;
  group: string;
  consumer: string;
  count?: number; // default 16
  blockMs?: number; // default 1000
  /** Called per entry, oldest-first (reclaimed-pending first, then fresh); acked right after it resolves.
   *  Return true to stop the loop (e.g. on a final/error frame). Never let a throw escape — catch inside
   *  or the loop treats it as a transient failure and backs off (mirror consumeTools's catch/backoff). */
  onEntry: (entry: StreamEntry) => boolean | Promise<boolean>;
  /** Checked before each poll cycle; the loop exits once this is true (mirrors consumeTools's `done` flag). */
  isDone: () => boolean;
}

/** Idempotently ensures the group exists, then drains `stream` via `group`/`consumer` until `isDone()` or
 *  `onEntry` returns true — reclaiming any stranded pending entries ONCE at start (crash recovery), then
 *  reading only fresh ('>') entries thereafter. Mirrors `RedisEngineRunner.consumeTools`'s existing shape;
 *  used by the realtime + watchdog consumer groups, and consumeTools itself now delegates here too. */
export async function drainTurnEventConsumer(
  opts: TurnEventConsumerOptions,
): Promise<void> {
  const { redis, stream, group, consumer, onEntry, isDone } = opts;
  const count = opts.count ?? 16;
  const blockMs = opts.blockMs ?? 1000;

  await redis.ensureGroup(stream, group);

  let claimedPending = false;
  while (!isDone()) {
    try {
      // On (re)attach, first reclaim any delivered-but-unacked entry a dead consumer left behind.
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
      // The failure may have happened AFTER XREADGROUP delivered entries but BEFORE we acked them. In that
      // case those entries are now in this group's PEL and a later `>` read will never return them. Re-run
      // the pending-recovery pass after the backoff so transient handler/Redis failures do not strand work.
      claimedPending = false;
      // A transient redis error (e.g. the connection closing on shutdown) would otherwise tight-spin —
      // back off briefly so we don't busy-loop while the process drains (mirrors consumeTools).
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
