/** The three-tier gate verdict, as it rides graph deltas and gate events. */
export type GateAction = 'respond' | 'acknowledge' | 'ignore';

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
  // A human approved or rejected a plan (dormant until the approval flow ports).
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
 * tokens (langchain folds cache reads + writes into it); `cacheRead`/`cacheWrite` are the cached
 * slices of that total.
 */
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
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
}
