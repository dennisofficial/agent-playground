import type { ConductorEvent, MessageUsage } from '../conductor-events.js';
import { chatCostUsd, gateCostUsd } from '../model.js';

/**
 * Plain, render-ready view of the conversation for the terminal UI. The conductor emits domain
 * `ConductorEvent`s (UI-agnostic); this layer maps each to a `RenderItem` the Ink components draw.
 * The `user`/`note` kinds have no event — they're the TUI's own local rows (the user's echoed input
 * and CLI slash-command output). A different surface (Slack, a logger) would consume the same events
 * and render its own way.
 */
/** A reaction folded onto its message node (e.g. a bot's gate ack). */
export interface Reaction {
  by: string;
  emoji: string;
}

export type RenderItem =
  | {
      id: string;
      kind: 'user';
      text: string;
      speaker?: string;
      ts?: string;
      reactions?: Reaction[];
    }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      speaker?: string;
      ts?: string;
      /** Per-message token usage from the model call that produced it; rendered dim at the end. */
      usage?: MessageUsage;
      /** Reactions folded onto this message (bots acking/👀-ing it) — patched in by id, not appended. */
      reactions?: Reaction[];
    }
  | { id: string; kind: 'tool'; toolName: string; speaker?: string }
  // Fallback ONLY: a reaction whose target message has already scrolled into the Static prefix (so it can
  // no longer be folded). Live targets fold via the store's `react` action instead.
  | { id: string; kind: 'reaction'; emoji: string; by: string }
  // Observability nodes, routed through the log bus (replacing raw stderr writes) — dim debug rows.
  | { id: string; kind: 'worker' | 'memory' | 'reminders' | 'workspace'; by?: string; text: string }
  // Debug only: the response gate's verdict + rationale for a bot, shown inline so you can see why a
  // bot spoke, reacted, or (importantly) stayed silent. Only soft-gate (LLM) calls carry a reason.
  | {
      id: string;
      kind: 'gate';
      by: string;
      action: 'respond' | 'acknowledge' | 'ignore';
      reasoning: string;
    }
  // CLI-local output for a slash command (e.g. /tasks dumping the open board) — never a chat message.
  | { id: string; kind: 'note'; text: string }
  // Debug only: the pre-LLM fetch — what memory/tasks the bot walked in knowing this turn.
  | { id: string; kind: 'recall'; by: string; text: string }
  // A human's approve/reject decision on a plan — shown inline so the transcript records the gate.
  | {
      id: string;
      kind: 'approval';
      decision: 'approved' | 'rejected';
      by: string;
      jobId: string;
      note?: string;
    }
  | { id: string; kind: 'error'; text: string };

/** Debug/observability rows — hidden by default and toggled by `/debug` (a "pure Slack" view shows only
 * chat: messages, reactions, approvals, notes, errors). Everything else is operator-facing diagnostics. */
const DEBUG_KINDS = new Set<RenderItem['kind']>([
  'gate',
  'recall',
  'memory',
  'reminders',
  'workspace',
  'worker',
  'tool',
]);
export const isDebug = (item: RenderItem): boolean => DEBUG_KINDS.has(item.kind);

/**
 * Map a conductor domain event to a terminal render row. Presentation decisions live here, not in the
 * core: the gate row's `$cost` string is formatted from the event's raw usage via `gateCostUsd`.
 */
export function renderEvent(e: ConductorEvent): RenderItem {
  switch (e.kind) {
    case 'message':
      // A human's own message renders as the cyan `user` row; a bot's as the green `assistant` row (with
      // its token usage). Same `id` as the channel message, so a reaction can fold onto either.
      return e.fromHuman
        ? { id: e.id, kind: 'user', text: e.text, speaker: e.authorName, ts: e.ts }
        : {
            id: e.id,
            kind: 'assistant',
            text: e.text,
            speaker: e.authorName,
            ts: e.ts,
            usage: e.usage,
          };
    case 'tool':
      return { id: e.id, kind: 'tool', toolName: e.toolName, speaker: e.botName };
    case 'reaction':
      return { id: e.id, kind: 'reaction', emoji: e.emoji, by: e.botName };
    case 'gate': {
      const u = e.usage;
      const cost = u
        ? `  ·  ${u.input} in · ${u.output} out · $${gateCostUsd(u.input, u.output).toFixed(6)}`
        : '';
      return {
        id: e.id,
        kind: 'gate',
        by: e.botName,
        action: e.action,
        reasoning: `${e.reasoning}${cost}`,
      };
    }
    case 'recall':
      return { id: e.id, kind: 'recall', by: e.botName, text: e.text };
    case 'approval':
      return {
        id: e.id,
        kind: 'approval',
        decision: e.decision,
        by: e.by,
        jobId: e.jobId,
        note: e.note,
      };
    case 'error':
      return { id: e.id, kind: 'error', text: e.message };
  }
}

/**
 * One-line dim token summary shown at the end of a rendered assistant message, e.g.
 * `812 in · 96 out · 640 cached · $0.001234`. The trailing `$cost` mirrors the gate row — same
 * presentation-layer treatment of raw usage — priced via `chatCostUsd` (Sonnet 4.6, cache-aware).
 */
export function formatMessageUsage(u: MessageUsage): string {
  const parts = [`${u.input} in`, `${u.output} out`];
  if (u.cacheRead) parts.push(`${u.cacheRead} cached`);
  if (u.cacheWrite) parts.push(`${u.cacheWrite} cache-write`);
  parts.push(`$${chatCostUsd(u).toFixed(6)}`);
  return parts.join(' · ');
}
