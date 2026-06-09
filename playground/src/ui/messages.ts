import type { ConductorEvent, MessageUsage } from '../conductor-events.js';
import { gateCostUsd } from '../model.js';

/**
 * Plain, render-ready view of the conversation for the terminal UI. The conductor emits domain
 * `ConductorEvent`s (UI-agnostic); this layer maps each to a `RenderItem` the Ink components draw.
 * The `user`/`note` kinds have no event — they're the TUI's own local rows (the user's echoed input
 * and CLI slash-command output). A different surface (Slack, a logger) would consume the same events
 * and render its own way.
 */
export type RenderItem =
  | { id: string; kind: 'user'; text: string; speaker?: string; ts?: string }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      speaker?: string;
      ts?: string;
      /** Per-message token usage from the model call that produced it; rendered dim at the end. */
      usage?: MessageUsage;
    }
  | { id: string; kind: 'tool'; toolName: string; speaker?: string }
  | { id: string; kind: 'reaction'; emoji: string; by: string }
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
  | { id: string; kind: 'error'; text: string };

/**
 * Map a conductor domain event to a terminal render row. Presentation decisions live here, not in the
 * core: the gate row's `$cost` string is formatted from the event's raw usage via `gateCostUsd`.
 */
export function renderEvent(e: ConductorEvent): RenderItem {
  switch (e.kind) {
    case 'message':
      return {
        id: e.id,
        kind: 'assistant',
        text: e.text,
        speaker: e.botName,
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
    case 'error':
      return { id: e.id, kind: 'error', text: e.message };
  }
}

/** One-line dim token summary shown at the end of a rendered assistant message, e.g. `812 in · 96 out · 640 cached`. */
export function formatMessageUsage(u: MessageUsage): string {
  const parts = [`${u.input} in`, `${u.output} out`];
  if (u.cacheRead) parts.push(`${u.cacheRead} cached`);
  if (u.cacheWrite) parts.push(`${u.cacheWrite} cache-write`);
  return parts.join(' · ');
}
