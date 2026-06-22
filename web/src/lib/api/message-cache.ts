import type { WebOutboundMessage } from './types';

/** Synthetic ts is `seconds.padded-seq` → numeric compare orders correctly. */
export function tsNum(ts: string): number {
  const n = Number(ts);
  return Number.isFinite(n) ? n : 0;
}

export function sortByTs(messages: WebOutboundMessage[]): WebOutboundMessage[] {
  return [...messages].sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
}

/** Upsert by `ts` (an edited card re-emits with the SAME ts → repaint in place, don't append). */
export function upsertByTs(
  list: WebOutboundMessage[],
  incoming: WebOutboundMessage,
): WebOutboundMessage[] {
  const idx = list.findIndex((m) => m.ts === incoming.ts);
  if (idx === -1) return sortByTs([...list, incoming]);
  const next = [...list];
  next[idx] = { ...next[idx], ...incoming };
  return sortByTs(next);
}

/** A thread's root ts = the reply parent, or the message's own ts if it's a root. */
export function rootTsOf(message: WebOutboundMessage): string {
  return message.threadTs ?? message.ts;
}

/**
 * Messages belonging to one thread. Coalesces `m.ts === threadTs || m.threadTs === threadTs` so the
 * root/headline post (whose own `ts` IS the threadTs and carries no `threadTs`) is included —
 * `/web/thread?threadTs=` alone drops it (BACKEND_GAPS.md #2).
 */
export function selectThreadMessages(
  all: WebOutboundMessage[],
  threadTs: string,
): WebOutboundMessage[] {
  return sortByTs(all.filter((m) => m.ts === threadTs || m.threadTs === threadTs));
}
