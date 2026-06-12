import type {
  ConductorEvent,
  MessageUsage,
} from '@harness/domain/conductor-events';
import { gateCostUsd } from '@harness/llm/chat-model.factory';
import {
  calculateCost,
  CHAT_MODEL,
  formatUsageLine,
} from '@harness/llm/usage-format';

/**
 * Plain, render-ready view of the conversation for the terminal UI. The conductor emits domain
 * `ConductorEvent`s (UI-agnostic); this layer maps each to a `RenderItem` the Ink components draw.
 * The `user`/`note` kinds have no event — they're the TUI's own local rows.
 * (Ported from playground/src/ui/messages.ts.)
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
      channelId?: string;
      reactions?: Reaction[];
    }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      speaker?: string;
      ts?: string;
      /** The room this message lives in — the App filters the transcript to the active room. */
      channelId?: string;
      /** Per-message token usage from the model call that produced it; rendered dim at the end. */
      usage?: MessageUsage;
      /** Reactions folded onto this message — patched in by id, not appended. */
      reactions?: Reaction[];
    }
  | { id: string; kind: 'tool'; toolName: string; speaker?: string }
  // Fallback ONLY: a reaction whose target message couldn't be found. Live targets fold instead.
  | { id: string; kind: 'reaction'; emoji: string; by: string }
  // Observability nodes — dim debug rows.
  | {
      id: string;
      kind: 'worker' | 'memory' | 'reminders' | 'workspace';
      by?: string;
      text: string;
    }
  // Debug only: the response gate's verdict + rationale.
  | {
      id: string;
      kind: 'gate';
      by: string;
      action: 'respond' | 'acknowledge' | 'ignore';
      reasoning: string;
    }
  // CLI-local output for a slash command — never a chat message.
  | { id: string; kind: 'note'; text: string }
  // Debug only: the pre-LLM fetch — what memory/tasks the bot walked in knowing this turn.
  | { id: string; kind: 'recall'; by: string; text: string }
  // A human's approve/reject decision on a plan (dormant until the approval flow ports).
  | {
      id: string;
      kind: 'approval';
      decision: 'approved' | 'rejected';
      by: string;
      jobId: string;
      note?: string;
    }
  | { id: string; kind: 'error'; text: string };

/** Debug/observability rows — hidden by default and toggled by `/debug` (a "pure Slack" view shows
 * only chat: messages, reactions, approvals, notes, errors). */
const DEBUG_KINDS = new Set<RenderItem['kind']>([
  'gate',
  'recall',
  'memory',
  'reminders',
  'workspace',
  'worker',
  'tool',
]);
export const isDebug = (item: RenderItem): boolean =>
  DEBUG_KINDS.has(item.kind);

/** Map a conductor domain event to a terminal render row. Presentation decisions live here.
 * Returns `null` for events that have no TUI representation (e.g. `usage`, consumed by the
 * SurfaceBridge for the Slack footer; the TUI already shows usage inline on the `assistant` row). */
export function renderEvent(e: ConductorEvent): RenderItem | null {
  switch (e.kind) {
    case 'message':
      return e.fromHuman
        ? {
            id: e.id,
            kind: 'user',
            text: e.text,
            speaker: e.authorName,
            ts: e.ts,
            channelId: e.channelId,
          }
        : {
            id: e.id,
            kind: 'assistant',
            text: e.text,
            speaker: e.authorName,
            ts: e.ts,
            channelId: e.channelId,
            usage: e.usage,
          };
    case 'tool':
      return {
        id: e.id,
        kind: 'tool',
        toolName: e.toolName,
        speaker: e.botName,
      };
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
    case 'usage':
      // Per-step usage events are consumed by the SurfaceBridge for the Slack footer; the TUI
      // already renders per-message usage inline on the `assistant` row. Return null so the App
      // skips adding any item to the store (avoids empty debug rows per billed step).
      return null;
  }
}

/**
 * One-line dim token summary shown at the end of a rendered assistant message, e.g.
 * `in 812 · out 96 · cache read 640 · $0.0012` — delegates to the shared `formatUsageLine`
 * helper so the TUI and the Slack Block Kit footer use the same format.
 */
export function formatMessageUsage(u: MessageUsage): string {
  return formatUsageLine({
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    costUsd: calculateCost(CHAT_MODEL, u),
  });
}
