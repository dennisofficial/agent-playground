import { encodeThreadKey } from '@/lib/routes';
import type { ThreadKind, ThreadStatus, WebOutboundMessage, WebThreadSummary } from './types';

/** Synthetic ts is `seconds.padded-seq` → numeric compare orders correctly. */
function tsNum(ts: string): number {
  const n = Number(ts);
  return Number.isFinite(n) ? n : 0;
}

export function sortByTs(messages: WebOutboundMessage[]): WebOutboundMessage[] {
  return [...messages].sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
}

/** Upsert by `ts` (an edited card re-emits with the SAME ts — repaint in place, don't append). */
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

function firstLine(text: string, max = 80): string {
  const line = (text ?? '').trim().split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function hasBuildEvent(messages: WebOutboundMessage[]): boolean {
  return messages.some((m) => (m.meta as { kind?: string } | undefined)?.kind === 'build_event');
}

function hasPrMarker(messages: WebOutboundMessage[]): boolean {
  return messages.some((m) => /pull request|\bPR #?\d+|github\.com\/[^\s]+\/pull\//i.test(m.text));
}

function hasOpenApprovalCard(messages: WebOutboundMessage[]): boolean {
  return messages.some((m) => m.card?.type === 'approval_card');
}

function hasVerdict(messages: WebOutboundMessage[]): boolean {
  return messages.some((m) => m.card?.type === 'verdict_card');
}

/**
 * Best-effort thread status derived from the outbox alone. This is DEMO-grade — authoritative status
 * needs `/web/pipeline` (unreachable, no threadId) or `/web/threads` (BACKEND_GAPS.md #1, #3).
 */
function deriveStatus(messages: WebOutboundMessage[]): ThreadStatus {
  if (hasPrMarker(messages)) return 'done';
  if (hasOpenApprovalCard(messages) && !hasVerdict(messages)) return 'awaiting_approval';
  if (hasBuildEvent(messages) || hasVerdict(messages)) return 'running';
  return 'scoping';
}

function deriveKind(title: string): ThreadKind {
  return /\b(fix|bug|hotfix|regression)\b/i.test(title) ? 'fix' : 'feat';
}

/**
 * Group a channel's flat message list into thread summaries (newest activity first). DEMO/live-outbox
 * only — the human's own messages and persisted threads aren't represented here.
 */
export function deriveThreadSummaries(
  channel: string,
  messages: WebOutboundMessage[],
): WebThreadSummary[] {
  const groups = new Map<string, WebOutboundMessage[]>();
  for (const m of messages) {
    const key = rootTsOf(m);
    const arr = groups.get(key);
    if (arr) arr.push(m);
    else groups.set(key, [m]);
  }

  const summaries: WebThreadSummary[] = [];
  for (const [rootTs, group] of groups) {
    const ordered = sortByTs(group);
    const title = firstLine(ordered[0]?.text ?? 'Untitled thread');
    const lastTs = ordered[ordered.length - 1]?.ts ?? rootTs;
    summaries.push({
      threadKey: encodeThreadKey(channel, rootTs),
      channel,
      threadTs: rootTs,
      title: title || 'Untitled thread',
      kind: deriveKind(title),
      status: deriveStatus(ordered),
      lastTs,
    });
  }

  return summaries.sort((a, b) => tsNum(b.lastTs) - tsNum(a.lastTs));
}

/** A short relative-ish meta line for a thread row ("12 messages · running"). */
export function threadMeta(summary: WebThreadSummary, count: number): string {
  return `${count} message${count === 1 ? '' : 's'}`;
}
