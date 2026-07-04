/**
 * thread-kind / spec — the `ThreadKindSpec`: one declarative descriptor per thread KIND, the seam that
 * binds a `threads.kind` row to everything the driver needs to run (or deliberately NOT run) it.
 *
 * This mirrors prompt-kit's inversion: just as a system prompt is "the set of fragments addressed to an
 * `Agent`", a thread kind is "the spec that binds it to an `Agent` (its prompt), an engine, a driver mode,
 * a lane, and its children". thread-kind → `Agent` is 1:1, so `renderAgentPrompt(spec.agent, ctx)` is the
 * prompt binding. Adding a new thread type = add a spec + an `Agent` + its `@Fragment` prompt — no new
 * harness. The registry (`registry.ts`) is boot-validated (`validateThreadKinds`) exactly like
 * `validateFragments`.
 */
import type { Agent } from '../prompt-kit';
import type { SessionEngine } from '../domain';
import type { CodexReasoningEffort } from '../engine';
import type { ThreadInput, ThreadKind as LaneKind } from '../surface/thread-registry';

/** The KIND of a `threads` row — the single differentiator across every thread-like concept. */
export type ThreadRowKind =
  | 'main' // the job brain session (operator conversation). Render/identity-only — driver never executes it.
  | 'builder' // a build lane's own execute session. Top-level executable; parents its review children.
  | 'master_review' // the ship-time Codex whole-diff review-&-fix. Top-level executable, runs last.
  | 'review_lens' // one post-build review lens over a builder's diff. Driven as a CHILD of the builder.
  | 'post_review' // the fix pass that applies a builder's deduped lens findings. Driven as a CHILD.
  | 'plan_review'; // the synchronous Codex plan review. Render/identity-only — runtime stays in the brain.

/**
 * How the DRIVER treats a kind:
 *  - `top-level` — driven by `runJob`'s top loop as a build section (`builder`, `master_review`).
 *  - `child` — driven ONLY via its parent builder's child mechanism (`review_lens`, `post_review`), never
 *    entered by the top loop.
 *  - `render-only` — a first-class row for identity + tree placement, but the driver NEVER executes it; its
 *    runtime lives elsewhere (`main` = the AgentSessionManager session; `plan_review` = the brain's
 *    synchronous `review_plan` tool + `codex_reviews`).
 */
export type ThreadExecution = 'top-level' | 'child' | 'render-only';

/** One child thread a parent spec materializes (a builder → N `review_lens` + 1 `post_review`). */
export interface ThreadChildSpec {
  kind: ThreadRowKind;
  /** The child row's one-line brief (e.g. a lens label, or "Post-review fixes"). */
  brief: string;
  /** The child row's kind-`config` (review_lens → `{ lensId }`; post_review → `{ minSeverity }`). */
  config: Record<string, unknown>;
}

/** The minimal parent view a `children` factory reads (the parent builder row). */
export interface ThreadKindParent {
  id: string;
  /** The parent's scope type (backend/frontend/…) — the future hook for scope-based lens selection. */
  type?: string;
  config: Record<string, unknown>;
}

/** One thread kind's full contract. */
export interface ThreadKindSpec {
  kind: ThreadRowKind;
  /** The prompt binding — `renderAgentPrompt(spec.agent, ctx)` assembles this kind's system prompt. */
  agent: Agent;
  /** Which engine backs this kind's turns (`claude` for builders/lenses/fixes, `codex` for the reviews). */
  engine: SessionEngine;
  /** The engine turn mode (`execute` writes, `review` is read-only, `conversational` is the brain session). */
  mode: 'execute' | 'review' | 'conversational';
  /** How the driver treats the kind — see {@link ThreadExecution}. */
  execution: ThreadExecution;
  /** Codex-only reasoning effort (e.g. `xhigh` for master review); undefined = the engine default. */
  reasoningEffort?: CodexReasoningEffort;
  /** Host-side gates that run after this kind's execute turn (the diagnostics done-gate + the ADR-0005
   *  live-verification judge). Master review carries its own verify mandate, so both are off for it. */
  gates: { verification: boolean; liveVerification: boolean };
  /** The wire lane this kind streams on — resolved through `surface/thread-registry.ts` (`laneFor`). */
  laneKind: LaneKind;
  /** Who holds the input side (operator composer / another agent / read-only). */
  inputPolicy: ThreadInput;
  /** Which entity's tasks column this kind's task-tool calls fold into (`none` = not tracked). */
  taskScope: 'thread' | 'main' | 'none';
  /** How the kind's turn is invoked — a fresh bounded `execute-turn`, or a long-lived `session-backed`
   *  runtime the driver does not own (the brain's `main`, the Codex plan-review session). */
  runner: 'execute-turn' | 'session-backed';
  /** The child threads this kind materializes when it finishes executing (builder → lenses + post_review).
   *  Absent for leaf kinds. */
  children?: (parent: ThreadKindParent) => ThreadChildSpec[];
}
