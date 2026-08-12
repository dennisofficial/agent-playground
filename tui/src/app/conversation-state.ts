import type { ContextReading } from "../domain/context-nudge.js";
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
  /**
   * The `ctx` reading: a percentage of the rotation BUDGET, which is allowed past 100, plus which
   * instrument put it there. Not a percentage of the physical window — a builder at 200K of a
   * million read `20%` green, on a meter that could not warn before the quality was gone.
   */
  contextPercent: ContextReading | null;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  notices: string[];
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
  contextPercent: null,
  fiveHour: null,
  sevenDay: null,
  notices: [],
  noAccount: null,
  closed: false,
};
