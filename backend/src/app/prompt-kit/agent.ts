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
  /** The build-time live-validation + evidence-capture subagent (spawned via Task on execute turns). */
  VALIDATE = 'validate',
  /** The ship-time Codex master review (`ship-master-review`). */
  MASTER_REVIEW = 'master_review',
  /** The auto-fix stage's read-only review pass + its fix-apply turn (each a system prompt; the per-run
   *  task lives in `autofix/autofix-lenses.ts`). */
  AUTOFIX_REVIEW = 'autofix_review',
  AUTOFIX_FIX = 'autofix_fix',
  /** The Codex plan-review turn's system prompt (its per-run task is `plan-review.service.renderPlanForReview`). */
  META_PLAN_REVIEW = 'meta_plan_review',
  // NOTE: the in-sandbox open-PR turn (`ship-open-pr`) + the ledger-promotion turn are NOT agents — they are
  // `prompt-kit/turns/` messages. The decision-class classifier, thread-titler, and live-verification judge
  // are host-side LangChain chains — their prompts live WITH those chains, not in prompt-kit at all.
}

/** Every agent — for a fragment that belongs in every assembled prompt. */
export const ALL: Agent[] = Object.values(Agent);

/** The code-changing build agents (worker orchestrator + its fan-out writers). */
export const BUILDERS: Agent[] = [Agent.WORKER, Agent.FAN_OUT];

/** The build agents that own capturing evidence artifacts into `/context/artifacts/` (the orchestrator
 *  + its dedicated live-validation subagent). Shared audience for `EVIDENCE_ARTIFACTS_NOTE`. */
export const EVIDENCE_OWNERS: Agent[] = [Agent.WORKER, Agent.VALIDATE];

/** The read-only advisory subagents (spawned via Task). */
export const ADVISORY: Agent[] = [
  Agent.EXPLORE,
  Agent.DOCS,
  Agent.REVIEW_AGENT,
  Agent.DEBUG,
  Agent.TEST,
];

/** EVERY engine subagent spawnable via `Task` inside a turn — the read-only advisory set plus the
 *  file-writing writers (`implement`/`implement-deep`) and the live `validate` subagent. These are the
 *  single-turn, no-conversation helpers; shared audience for `SUBAGENT_KERNEL_NOTE`. (Excludes the ship-time
 *  PR/master-review turns, which are full sessions, not Task subagents.) */
export const ENGINE_SUBAGENTS: Agent[] = [...ADVISORY, Agent.VALIDATE, Agent.FAN_OUT];

/** Every code-review surface (the per-diff `review` subagent + the ship-time master review). */
export const REVIEWERS: Agent[] = [Agent.REVIEW_AGENT, Agent.MASTER_REVIEW];
