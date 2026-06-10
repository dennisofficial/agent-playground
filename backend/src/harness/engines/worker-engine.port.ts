/**
 * The worker-engine seam. The chat agent / conductor / UI are unchanged; only the *execution* of a
 * dispatched job goes through a `WorkerEngine`, so the custom LangGraph worker, the Claude Agent
 * SDK, and the Codex SDK are interchangeable behind one interface.
 * (Ported from playground/src/engines/types.ts.)
 */

/** The interchangeable worker backends. */
export type WorkerEngineName = 'claude' | 'codex' | 'langgraph';

/**
 * Reasoning-effort level for a worker run. Mirrors the Claude Agent SDK's `effort` option (the seam
 * stays SDK-agnostic by re-declaring the union rather than importing it). Only the Claude engine
 * honors it today; Codex/LangGraph ignore it.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * A normalized progress event, emitted by every engine regardless of its native event shape. This
 * is what feeds the per-job progress buffer that `check_job` reads — decoupled from any one SDK.
 */
export type WorkerEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'result'; text: string };

export interface RunWorkerArgs {
  task: string;
  /** Directory the worker is scoped to (the project root). */
  cwd: string;
  /** The composed worker persona for this engine (correct tool names per engine). */
  systemPrompt: string;
  /** A prior engine session/thread id to resume, if any. */
  sessionId?: string;
  /** Override the engine's model for this run (e.g. a high-reasoning model for planning, a cheaper
   * one for executing). Falls back to the engine's env/default when unset. */
  model?: string;
  /** Reasoning effort for this run (Claude only). Unset → the model's default. */
  effort?: EffortLevel;
  /** True for a PLAN pass: the engine restricts the worker to read-only (no file writes / mutating
   * shell), so "plan first, don't touch anything" is structurally enforced, not just requested. */
  planning?: boolean;
  /** Called for each progress event as the worker runs. */
  onEvent: (e: WorkerEvent) => void;
  /** Aborts the run when signalled — the engine wires it to its native cancellation. Kept
   * engine-agnostic so it survives the move to out-of-process / containerized workers. */
  signal?: AbortSignal;
}

export interface WorkerEngine {
  readonly name: WorkerEngineName;
  /** Run a task to completion. Returns the final summary and the engine's session id (for resume). */
  run(args: RunWorkerArgs): Promise<{ result: string; sessionId?: string }>;
}
