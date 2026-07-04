/**
 * prompt-kit / agent — the AUDIENCE dimension of the fragment library.
 *
 * A system prompt is assembled for exactly ONE `Agent`: `PromptService.generate(agent, ctx)` (or the pure
 * `renderAgentPrompt`) selects every fragment whose `usedBy` includes that agent. This is the Claude-Code-style
 * inversion — there is no whole-body prompt per role; a role's prompt is the set of fragments addressed to it.
 *
 * Onboarding is NOT an agent — it is the SAME `ATLAS_MAIN` agent under `ctx.jobKind === 'onboarding'`.
 */
export enum Agent {
  /** The conversational job brain (intent → grill → plan → steer; also the onboarding bring-up persona). */
  ATLAS_MAIN = 'atlas_main',
  /** A build/execute thread orchestrator (`worker-orchestrate`). */
  WORKER = 'worker',
  /** A fan-out writer subagent (`implement`/`implement-deep`) — the only subagent that changes files. */
  FAN_OUT = 'fan_out',
  /** Read-only advisory subagents (spawned via Task inside an engine turn). */
  EXPLORE = 'explore',
  DOCS = 'docs',
  REVIEW_AGENT = 'review_agent',
  DEBUG = 'debug',
  TEST = 'test',
  /** The ship-time PR-review orchestrator (`ship-pr-review`). */
  PR_REVIEW = 'pr_review',
  /** The ship-time Codex master review (`ship-master-review`). */
  MASTER_REVIEW = 'master_review',
  /** The in-sandbox open-PR turn (push + `gh pr create`). */
  SHIP_OPEN_PR = 'ship_open_pr',
  /** The auto-fix stage's read-only review pass + its fix-apply turn. */
  AUTOFIX_REVIEW = 'autofix_review',
  AUTOFIX_FIX = 'autofix_fix',
  /** Host-side meta LLM chains (not in-sandbox agents). */
  META_PLAN_REVIEW = 'meta_plan_review',
  META_CLASSIFIER = 'meta_classifier',
  META_TITLER = 'meta_titler',
  /** The live-verification judge (ADR 0005) — adjudicates a thread's `complete_thread` claim. */
  META_LIVE_VERIFICATION_JUDGE = 'meta_live_verification_judge',
}

/** Every agent — for a fragment that belongs in every assembled prompt. */
export const ALL: Agent[] = Object.values(Agent);

/** The code-changing build agents (worker orchestrator + its fan-out writers). */
export const BUILDERS: Agent[] = [Agent.WORKER, Agent.FAN_OUT];

/** The read-only advisory subagents (spawned via Task). */
export const ADVISORY: Agent[] = [
  Agent.EXPLORE,
  Agent.DOCS,
  Agent.REVIEW_AGENT,
  Agent.DEBUG,
  Agent.TEST,
];

/** Every code-review surface (the per-diff `review` subagent + the two ship-time reviews). */
export const REVIEWERS: Agent[] = [Agent.REVIEW_AGENT, Agent.PR_REVIEW, Agent.MASTER_REVIEW];
