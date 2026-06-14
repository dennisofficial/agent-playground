/**
 * The worker-engine seam. The chat agent / conductor / UI are unchanged; only the *execution* of a
 * session turn goes through a `WorkerEngine`, so the custom LangGraph worker, the Claude Agent
 * SDK, and the Codex SDK are interchangeable behind one interface.
 * (Ported from playground/src/engines/types.ts.)
 */

/** The interchangeable worker backends. */
export enum EWorkerEngineName {
  CLAUDE = 'claude',
  CODEX = 'codex',
  LANGGRAPH = 'langgraph',
}

/**
 * The mode of one session turn. 'plan' = the engine's native read-only planning posture (agents
 * plan deeper when the engine itself enforces look-don't-touch, ending in a plan artifact);
 * 'execute' = write-capable within the session's worktree; 'investigate' = read-only like plan but
 * WITHOUT the native plan ceremony (no ExitPlanMode / plan artifact) — a fast, direct answer FROM the
 * codebase. Chosen per turn by the owning employee — approving a plan is simply the next turn
 * arriving with mode 'execute'. Both 'plan' and 'investigate' are read-only at the engine seam.
 */
export type WorkerMode = 'plan' | 'execute' | 'investigate';

/**
 * The ROLE a worker run plays — the key for per-employee engine/model/prompt bindings
 * (`EmployeeDefinition.roles`). 'plan'/'execute' are also session modes; 'review' is a one-shot
 * adversarial pass (the plan self-review, and the lead's peer review) that never becomes a long-lived
 * session mode. (The 'investigate' session mode reuses the 'execute' recipe — it isn't its own role.)
 */
export type WorkerRole = 'plan' | 'execute' | 'review';

/**
 * Reasoning-effort level for a worker run. Mirrors the Claude Agent SDK's `effort` option (the seam
 * stays SDK-agnostic by re-declaring the union rather than importing it). Only the Claude engine
 * honors it today; Codex/LangGraph ignore it.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * One clarifying question a worker asked mid-plan, normalized from the engine's native shape (the
 * Claude SDK's AskUserQuestion input; the seam stays SDK-agnostic by re-declaring it, like
 * EffortLevel). A turn that asks ends with the questions as its report instead of a plan.
 */
export interface WorkerQuestionOption {
  label: string;
  description?: string;
}
export interface WorkerQuestion {
  question: string;
  /** Short topic label (the SDK caps it at 12 chars). */
  header?: string;
  options: WorkerQuestionOption[];
  multiSelect?: boolean;
}

/**
 * A normalized progress event, emitted by every engine regardless of its native event shape. This
 * is what feeds the per-session transcript that `check_session`/`search_session` read — decoupled
 * from any one SDK.
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
  /** The owning employee's id — namespaces the engine's isolated config/state HOME so each employee
   * owns their own CLAUDE_CONFIG_DIR / CODEX_HOME (skills and MCP servers are granted PER EMPLOYEE,
   * not team-wide, so the homes must not be shared). See engine-home.ts. */
  agentId: string;
  /** A prior engine session/thread id to resume, if any. */
  sessionId?: string;
  /** Override the engine's model for this run (e.g. a high-reasoning model for planning, a cheaper
   * one for executing). Falls back to the engine's env/default when unset. */
  model?: string;
  /** Reasoning effort for this run (Claude only). Unset → the model's default. */
  effort?: EffortLevel;
  /** This turn's mode. REQUIRED (no default): a missing mode must never silently grant writes.
   * 'plan' and 'investigate' both restrict the worker to read-only at the engine seam, so "look,
   * don't touch" is structurally enforced, not just requested ('plan' adds the native plan ceremony;
   * 'investigate' skips it for a fast direct answer). Only 'execute' may write. */
  mode: WorkerMode;
  /** The owning workspace's LLM API key for this run (single-process multi-tenant: each tenant
   * funds its own engine runs). Passed into the engine's subprocess env, NOT the shared process.env.
   * Unset → the engine falls back to its own env (dev/TUI). */
  apiKey?: string;
  /** Called for each progress event as the worker runs. */
  onEvent: (e: WorkerEvent) => void;
  /** Aborts the run when signalled — the engine wires it to its native cancellation. Kept
   * engine-agnostic so it survives the move to out-of-process / containerized workers. */
  signal?: AbortSignal;
}

/**
 * Vendor-neutral token-usage shape returned by every engine. All fields are optional so existing
 * engines compile unchanged before they start populating it.
 *
 * Token convention (uniform across engines):
 * - `inputTokens`  = grand total input INCLUDING cache (fresh + cacheRead + cacheWrite).
 * - `outputTokens` = grand total output INCLUDING reasoning.
 * - `cacheReadTokens` / `cacheWriteTokens` = sub-slices of `inputTokens`.
 * - `reasoningTokens` = sub-slice of `outputTokens` (informational only).
 * - `costUsd` = exact cost when the SDK provides it (Claude SDK); absent when inferred server-side (Codex).
 * - `model` = the real model id used for the run (important when the engine ignores `turnModel`).
 */
export interface IWorkerUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  model?: string;
}

export interface WorkerEngine {
  readonly name: EWorkerEngineName;
  /** Run one turn to completion (the engine loops internally until it has a report). Returns the
   * final report and the engine's session id — the resume handle for the session's next turn.
   * `questions` is set when the turn ended by ASKING (the runner renders them as the report and
   * the owner answers on the next turn); `planText` when a plan was captured (Claude engines set
   * result to the plan today). `usage` carries token/cost counts for Langfuse generation tracking.
   * All optional so Codex/LangGraph compile unchanged before they populate usage. */
  run(args: RunWorkerArgs): Promise<{
    result: string;
    sessionId?: string;
    questions?: WorkerQuestion[];
    planText?: string;
    usage?: IWorkerUsage;
  }>;
}
