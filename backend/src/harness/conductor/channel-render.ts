import type { ChannelMsg } from '../channel/channel.types';

/**
 * Pure rendering helpers for injecting time context into the LLM's view of the channel.
 *
 * These are deliberately ephemeral: computed at render time from immutable message stamps,
 * never written into the durable checkpoint (mirrors the `recalled`/`repairDanglingToolCalls`
 * idiom in bot-graph.factory.ts). The prompt-cache prefix (system prompt + durable history)
 * is untouched — only the volatile block that comes after the history cache breakpoint uses
 * these helpers.
 *
 * Design note: `formatStamp` uses a fixed locale ('en-US') so output is stable regardless of
 * the server's system locale. Timezone defaults to server-local; a future `HARNESS_TZ` env var
 * could thread through here if needed.
 */

/** One item the LLM history renderer produces — a real message or a time-gap marker. */
export type RenderItem =
  | { kind: 'message'; msg: ChannelMsg }
  | { kind: 'time-divider'; gapMs: number; label: string };

/** Default gap threshold (1 hour in ms). Override with `HARNESS_TIMESTAMP_GAP_MS`. */
export const GAP_THRESHOLD_DEFAULT_MS = 3_600_000;

/** True when two epoch-ms values fall on the same calendar day (server-local timezone). */
export function sameCalendarDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/**
 * Format an epoch-ms timestamp as a human-readable stamp for the LLM, e.g.
 * "Wed Jun 10, 21:30". Uses 24h clock, en-US locale, server-local timezone.
 */
export function formatStamp(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Describe a gap duration in natural language, e.g. "3 hours later", "2 days later".
 * Used in divider labels and the leading-gap note.
 */
export function formatGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} later`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} later`;
  const days = Math.round(ms / 86_400_000);
  return `${days} day${days !== 1 ? 's' : ''} later`;
}

/**
 * Walk a sequence of channel messages and insert `time-divider` items between consecutive
 * messages separated by more than `gapThresholdMs` OR crossing a calendar-day boundary.
 *
 * Safe with `createdAt === 0` or missing (treats consecutive 0-stamped messages as same-time,
 * no divider inserted) — pre-feature checkpoint messages without real stamps are left unbroken.
 */
export function withDividers(
  msgs: ChannelMsg[],
  gapThresholdMs: number,
): RenderItem[] {
  const items: RenderItem[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (i > 0) {
      const prev = msgs[i - 1];
      // Only insert a divider when both stamps look real (> 0); skip for synthetic 0-stamps.
      const gap = m.createdAt - prev.createdAt;
      if (
        m.createdAt > 0 &&
        prev.createdAt > 0 &&
        (gap >= gapThresholdMs || !sameCalendarDay(prev.createdAt, m.createdAt))
      ) {
        items.push({
          kind: 'time-divider',
          gapMs: gap,
          label: `——— ${formatGap(gap)} (${formatStamp(m.createdAt)}) ———`,
        });
      }
    }
    items.push({ kind: 'message', msg: m });
  }
  return items;
}

/**
 * Build the volatile time-context string injected into the LLM's view each turn.
 *
 * Always includes "Current time: …". When there's a significant gap between the last consumed
 * message (`prevCreatedAt`) and the first message in the fresh batch, a gap note is appended.
 *
 * @param fresh          New messages the bot hasn't consumed yet.
 * @param prevCreatedAt  The `createdAt` of the last message already in history, if any.
 * @param gapThresholdMs Minimum gap (ms) that earns a note.
 */
export function buildTimeContext(
  fresh: ChannelMsg[],
  prevCreatedAt: number | undefined,
  gapThresholdMs: number,
): string {
  const now = Date.now();
  const lines: string[] = [`Current time: ${formatStamp(now)}`];

  if (
    prevCreatedAt !== undefined &&
    prevCreatedAt > 0 &&
    fresh.length > 0 &&
    fresh[0].createdAt > 0
  ) {
    const gap = fresh[0].createdAt - prevCreatedAt;
    if (
      gap >= gapThresholdMs ||
      !sameCalendarDay(prevCreatedAt, fresh[0].createdAt)
    ) {
      lines.push(`[${formatGap(gap)} since the previous message in this conversation]`);
    }
  }

  return lines.join('\n');
}
