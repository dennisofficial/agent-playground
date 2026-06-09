import type { GateAction } from './bot-graph.js';

/**
 * The conductor's domain event stream — what a bot *said* or *did*, plus observability. This is the
 * seam between the orchestration core and any presentation surface: the terminal UI accumulates these
 * into render rows, a logger could write them, and a future Slack adapter would post them. The core
 * emits these and holds NO UI state; consumers decide what to render, retain, or drop.
 *
 * Every event carries a stable `id` (Ink `<Static>` keys need it today; dedupe / replay / Slack will
 * too). For `message`, `id` is the channel message id — the same id used for `channel.append`, so the
 * channel write and its render row line up. For every other kind, `id` is a conductor `emitSeq` id.
 */
export type ConductorEvent =
  | {
      id: string;
      kind: 'message';
      /** Who authored it — a bot id, or the human speaker's id. */
      authorId: string;
      authorName: string;
      /** True for the human's own messages (rendered distinctly); false for a bot's. Lets a reaction
       * fold onto a human message too, and keeps the event shape honest for non-TUI consumers. */
      fromHuman: boolean;
      text: string;
      /** Per-message token usage from the model call that produced it — bot messages only. */
      usage?: MessageUsage;
      ts: string;
    }
  | { id: string; kind: 'tool'; botId: string; botName: string; toolName: string }
  | {
      id: string;
      kind: 'reaction';
      botId: string;
      botName: string;
      emoji: string;
      /** The channel-message id this reaction is on, so the UI folds it INTO that message node
       * instead of appending a standalone row. */
      targetId: string;
    }
  // Observability: the response gate's verdict + rationale (why a bot spoke, reacted, or stayed
  // silent). `usage` is the raw gate-call cost — the consumer formats it (e.g. the TUI shows $). Only
  // soft-gate (LLM) calls carry `reasoning`/`usage`; hard rules omit them.
  | {
      id: string;
      kind: 'gate';
      botId: string;
      botName: string;
      action: GateAction;
      reasoning: string;
      usage?: { input: number; output: number };
    }
  // Observability: the pre-LLM fetch — what memory/tasks the bot walked in knowing this turn.
  | { id: string; kind: 'recall'; botId: string; botName: string; text: string }
  // A human approved or rejected a plan (the code-level human-in-the-loop gate). Surface-agnostic: the
  // terminal renders it as a transcript row; a Slack adapter could post it to the thread.
  | {
      id: string;
      kind: 'approval';
      jobId: string;
      decision: 'approved' | 'rejected';
      by: string;
      note?: string;
    }
  | { id: string; kind: 'error'; message: string };

export interface ContextUsage {
  input?: number;
  output?: number;
}

/**
 * Per-message token usage, broken out so a renderer can show cache hits. `input` is the TOTAL input
 * tokens (langchain folds cache reads + writes into it); `cacheRead`/`cacheWrite` are the cached slices
 * of that total — `cacheRead` served at ~0.1× price, `cacheWrite` written this call at ~2× (1-hour TTL).
 */
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
