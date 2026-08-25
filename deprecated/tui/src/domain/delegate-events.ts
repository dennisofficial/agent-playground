/**
 * The delegate half of the engine event union.
 *
 * Split out of `message.ts` because it is a whole vocabulary rather than a couple of members: four
 * frame shapes, an enum and a reference type, all describing work this thread SPAWNED rather than work
 * it did. `message.ts` unions these in and re-exports the names, so nothing outside has to know the
 * union arrives from two files — the split is about reading, not about imports.
 *
 * The rules these encode, and the reasons, are in `delegates.ts`, which is what consumes them.
 */

/**
 * How a delegated run ended, or that it has not. The SDK's three terminal words plus the state before
 * them, so one field answers "is this still going" and "how did it go" without a second boolean that
 * can disagree with it.
 */
export enum EDelegateStatus {
  running = 'running',
  completed = 'completed',
  failed = 'failed',
  stopped = 'stopped',
}

/** The settled half of `EDelegateStatus` — what a `task_settled` frame is allowed to say. */
export type DelegateOutcome = Exclude<EDelegateStatus, EDelegateStatus.running>;

/** One live background task as the SDK's level signal names it. Ids only; see `background_tasks`. */
export type BackgroundTaskRef = {
  taskId: string;
  taskType: string;
  description: string;
};

/**
 * A delegated run began — a subagent, a backgrounded shell, a workflow. `parentToolUseId` is the
 * spawning tool call's id, which is what joins this to the block already in the transcript.
 */
export type TaskStartedEvent = {
  kind: 'task_started';
  taskId: string;
  parentToolUseId?: string;
  description: string;
  agentType?: string;
  taskType?: string;
  background: boolean;
};

export type TaskProgressEvent = {
  kind: 'task_progress';
  taskId: string;
  parentToolUseId?: string;
  toolUses: number;
  durationMs: number;
  lastTool?: string;
  /** The SDK's periodic AI-written gist, present only with `agentProgressSummaries` on. */
  summary?: string;
};

export type TaskSettledEvent = {
  kind: 'task_settled';
  taskId: string;
  parentToolUseId?: string;
  status: DelegateOutcome;
  summary?: string;
};

/**
 * Every live background task after a membership change. A LEVEL, not an edge: the payload replaces the
 * set outright, so a missed bookend cannot wedge a stale indicator on screen. It is per-process and
 * nothing is emitted at startup, which is why the set resets when a turn opens.
 */
export type BackgroundTasksEvent = {
  kind: 'background_tasks';
  tasks: readonly BackgroundTaskRef[];
};

export type DelegateEvent =
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskSettledEvent
  | BackgroundTasksEvent;
