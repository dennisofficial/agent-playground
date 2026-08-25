import type { ContextReading } from "../domain/context-nudge.js";
import { NO_DELEGATES, type Delegates } from "../domain/delegates.js";
import type { Message, TurnSummary } from "../domain/message.js";
import type { UsageWindow } from "../domain/usage.js";

/**
 * What one thread's conversation IS, apart from the machinery that moves it.
 *
 * Split from `conversation.store.ts` so the shape can be read — and constructed in a test — without
 * the frame-tick and reveal arithmetic beside it. `ConversationStore` re-exports every name here, so
 * importers do not have to know which half a type lives in.
 */

export type LiveTail = { kind: "text" | "thinking"; text: string } | null;

export type RunningTool = {
  toolUseId: string;
  name: string;
  target?: string | undefined;
  startedAt: number;
  lines: string[];
} | null;

export type QueuedSteer = { id: string; text: string };

export type ConversationState = {
  messages: Message[];
  tail: LiveTail;
  runningTool: RunningTool;
  running: boolean;
  startedAt: number | null;
  outputTokens: number;
  lastTurn: TurnSummary | null;
  interrupting: boolean;
  queued: QueuedSteer[];
  /** Everything the `ctx` meter draws — tokens, window fill, budget pressure, and which instrument. */
  contextReading: ContextReading | null;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  notices: string[];
  /**
   * What this thread DELEGATED, live only. Never persisted: a delegate reports back through its
   * spawning tool call's result, which is, so the transcript keeps the answer and drops the working.
   * See `domain/delegates.ts`.
   */
  delegates: Delegates;
  /**
   * The model has finished speaking but the turn cannot end — a backgrounded delegate is still running
   * and the session has to stay open to hear it settle. Distinct from `running`, which stays true: the
   * turn IS still in flight, but nothing is being written, and a shimmer over an idle session reads as
   * an agent that has hung.
   */
  holding: boolean;
  /**
   * Why this conversation cannot run a turn for want of a credential, or null when it can. A STATE
   * rather than an error: a session is allowed to hold no account, and the hint line says so where the
   * meters would be instead of a failure arriving as a banner over a job that half-exists.
   */
  noAccount: string | null;
  /** Set when another instance holds this thread's session lock. */
  closed: boolean;
};

/** A thread nobody has spoken in yet — also what `reset()` returns a store to. */
export const EMPTY: ConversationState = {
  messages: [],
  tail: null,
  runningTool: null,
  running: false,
  startedAt: null,
  outputTokens: 0,
  lastTurn: null,
  interrupting: false,
  queued: [],
  contextReading: null,
  fiveHour: null,
  sevenDay: null,
  notices: [],
  delegates: NO_DELEGATES,
  holding: false,
  noAccount: null,
  closed: false,
};
