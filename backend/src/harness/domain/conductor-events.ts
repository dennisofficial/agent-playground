/** The three-tier gate verdict, as it rides graph deltas and gate events. */
export type GateAction = 'respond' | 'acknowledge' | 'ignore';

/**
 * Per-bot aggregate token usage accumulated across ALL steps of a single Slack post — gate call(s),
 * every LLM step in the turn (including tool-call-only steps), and prior ignore/ack turns whose gate
 * costs rolled forward. Flushed and reset when the bot posts a message; displayed as a Block Kit
 * footer on the Slack message.
 */
export interface AccumulatedUsage {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes billed at the 5-minute TTL rate (standard cache writes). */
  cacheWrite5m: number;
  /** Cache writes billed at the 1-hour TTL rate (extended-cache-ttl-2025-04-11 beta). */
  cacheWrite1h: number;
  costUsd: number;
  /** How many LLM round-trips (gate + chat steps) contributed to this post.
   * Shown in the Slack footer only when > 1, e.g. `claude-sonnet-4-6 · 3 calls · in …`. */
  callCount: number;
}

/**
 * The conductor's domain event stream — what a bot *said* or *did*, plus observability. This is the
 * seam between the orchestration core and any presentation surface: the terminal UI accumulates
 * these into render rows, a logger could write them, and the Slack adapter will post them. The core
 * emits these and holds NO UI state; consumers decide what to render, retain, or drop.
 *
 * Every event carries a stable `id`. For `message`, `id` is the channel message id — the same id
 * used for `channel.append`, so the channel write and its render row line up. For every other kind,
 * `id` is a conductor `emitSeq` id. (Ported from playground/src/conductor-events.ts; the `approval`
 * variant stays dormant until the plan-approve-execute flow ports.)
 */
export type ConductorEvent =
  | {
      id: string;
      kind: 'message';
      /** Channel/thread coordinate the message lives on — what the SurfaceBridge routes post() by. */
      channelId: string;
      /** Who authored it — a bot id, or the human speaker's id. */
      authorId: string;
      authorName: string;
      /** True for the human's own messages (rendered distinctly); false for a bot's. */
      fromHuman: boolean;
      text: string;
      /** Per-message token usage from the model call that produced it — bot messages only. */
      usage?: MessageUsage;
      /** Slack file IDs uploaded via share_artifact during this turn — attached to the outbound
       * message via chat.update(file_ids) after the text post lands. */
      fileIds?: string[];
      ts: string;
    }
  | {
      id: string;
      kind: 'tool';
      botId: string;
      botName: string;
      toolName: string;
    }
  | {
      id: string;
      kind: 'reaction';
      /** Channel/thread coordinate of the target message — what the SurfaceBridge routes react() by. */
      channelId: string;
      botId: string;
      botName: string;
      emoji: string;
      /** The channel-message id this reaction is on, so the UI folds it INTO that message node. */
      targetId: string;
      /** When true, REMOVE this reaction instead of adding it (clears the transient "composing"
       * marker at turn end). Absent/false = add (back-compat). */
      remove?: boolean;
    }
  // Observability: the response gate's verdict + rationale (why a bot spoke, reacted, or stayed
  // silent). Only soft-gate (LLM) calls carry `reasoning`/`usage`; hard rules omit them.
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
  // Observability: a composed reply suppressed at the post seam (read-the-room) — teammates posted
  // while the model was composing, so the bot is revising instead of posting. The only trace of a
  // suppressed draft; its token usage rides a separate `usage` event (it's still a billed step).
  | { id: string; kind: 'draft'; botId: string; botName: string; text: string }
  // A human approved or rejected a plan (dormant until the approval flow ports).
  | {
      id: string;
      kind: 'approval';
      jobId: string;
      decision: 'approved' | 'rejected';
      by: string;
      note?: string;
    }
  | { id: string; kind: 'error'; message: string }
  // Observability: a human message (burst) reached room quiescence with ZERO respond-action turns
  // — nobody picked it up. The under-response signal (measured, not yet auto-fixed). One per burst.
  | {
      id: string;
      kind: 'dropped';
      channelId: string;
      /** The dropped human message text + its channel seq. */
      text: string;
      seq: number;
    }
  // Observability: per-step token usage for the chat LLM path (one event per billed AI step).
  // Consumed by the SurfaceBridge to build the per-post aggregate footer; not rendered by the TUI.
  | {
      id: string;
      kind: 'usage';
      botId: string;
      role: 'chat';
      usage: MessageUsage;
    };

export interface ContextUsage {
  input?: number;
  output?: number;
}

/**
 * Per-message token usage, broken out so a renderer can show cache hits. `input` is the TOTAL input
 * tokens (langchain folds cache reads + writes into it); `cacheRead`/`cacheWrite5m`/`cacheWrite1h`
 * are the cached slices of that total, split by TTL bucket.
 */
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead?: number;
  /** Cache writes at the 5-minute TTL rate. */
  cacheWrite5m?: number;
  /** Cache writes at the 1-hour TTL rate (extended-cache-ttl-2025-04-11 beta). */
  cacheWrite1h?: number;
}

/** Ephemeral, overwrite-style status that drives the TUI spinner/footer — a pull snapshot, distinct
 * from the append-only event stream. */
export interface ConductorStatus {
  /** True while any bot is working (drives the spinner; input stays live regardless). */
  busy: boolean;
  ctx: ContextUsage;
  /** Count of running background JOBS (footer). */
  running: number;
  /** Who the surface is currently speaking as (lowercased id). */
  speaker: string;
  /** Display names of bots currently working a turn. */
  thinking: string[];
  /** Cumulative under-response drops this session (human bursts that got no respond-action turn). */
  dropped: number;
}
