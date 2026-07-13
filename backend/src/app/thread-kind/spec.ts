/**
 * thread-kind / spec — the `ThreadKindSpec`: one declarative descriptor per thread ROLE, the seam that
 * binds a `threads.role` row to everything the driver needs to run (or deliberately NOT run) it.
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
import type { ReasoningEffort } from '../engine';
import type { ThreadInput, ThreadKind as LaneKind } from '../surface/thread-registry';

/**
 * The ROLE of a `threads` row — the single differentiator across every thread-like concept (renamed from
 * `ThreadRowKind`, d2/d7 — grouping now lives on `stage.kind`, see `../stage-kind`). Mapping from the old
 * kind vocabulary: `main→planning`, `review_lens→review_agent`, `post_review→review_fix`; `post_build` and
 * `ci` are new roles for the split-off ship/CI stages (d14).
 */
export type ThreadRole =
  | 'planning' // the job brain session (operator conversation). Render/identity-only — driver never executes it.
  | 'plan_review' // the synchronous Codex plan review. Render/identity-only — runtime stays in the brain.
  | 'builder' // a build lane's own execute session. Top-level executable; parents its review children.
  | 'review_agent' // one post-build review lens over a builder's diff. Driven as a CHILD of the builder.
  | 'review_fix' // the fix pass that applies a builder's deduped lens findings. Driven as a CHILD.
  | 'master_review' // the ship-time Codex whole-diff review-&-fix. Top-level executable, runs last.
  | 'post_build' // the ship/amend stage-thread (d11/d14) — takes over `openPrAtShip` from Main.
  | 'ci'; // the post-ship CI stage-thread (d14) — takes over CI handling from Main.

/**
 * How the DRIVER treats a role:
 *  - `top-level` — driven by `runJob`'s top loop as a build section (`builder`, `master_review`).
 *  - `child` — driven ONLY via its parent builder's child mechanism (`review_agent`, `review_fix`), never
 *    entered by the top loop.
 *  - `render-only` — a first-class row for identity + tree placement, but the driver NEVER executes it; its
 *    runtime lives elsewhere (`planning` = the AgentSessionManager session; `plan_review` = the brain's
 *    synchronous `review_plan` tool).
 */
export type ThreadExecution = 'top-level' | 'child' | 'render-only';

/** One child thread a parent spec materializes (a builder → N `review_agent` + 1 `review_fix`). */
export interface ThreadChildSpec {
  kind: ThreadRole;
  /** The child row's one-line brief (e.g. a lens label, or "Post-review fixes"). */
  brief: string;
  /** The child row's kind-`config` (review_agent → `{ lensId }`; review_fix → `{ minSeverity }`). */
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
  kind: ThreadRole;
  /** The prompt binding — `renderAgentPrompt(spec.agent, ctx)` assembles this kind's system prompt. */
  agent: Agent;
  /** Which engine backs this kind's turns (`claude` for builders/lenses/fixes, `codex` for the reviews). */
  engine: SessionEngine;
  /** The engine turn mode (`execute` writes, `review` is read-only, `conversational` is the brain session). */
  mode: 'execute' | 'review' | 'conversational';
  /** How the driver treats the kind — see {@link ThreadExecution}. */
  execution: ThreadExecution;
  /** Engine-agnostic reasoning effort (e.g. `xhigh` for master review); undefined = the engine default. */
  reasoningEffort?: ReasoningEffort;
  /** Host-side gates that run after this kind's execute turn (the diagnostics done-gate + the ADR-0005
   *  live-verification judge). Master review carries its own verify mandate, so both are off for it. */
  gates: { verification: boolean; liveVerification: boolean };
  /** The wire lane this kind streams on — resolved through `surface/thread-registry.ts` (`laneFor`). */
  laneKind: LaneKind;
  /** Who holds the input side (operator composer / another agent / read-only). */
  inputPolicy: ThreadInput;
  /** Whether the OPERATOR may chat with a thread of this role at all (d12) — uniform capability, per-role
   *  toggle. `true` for `builder` (live-steer while running, guidance while halted) and `planning` (the
   *  operator conversation); `false` (read-only) elsewhere by default. Distinct from {@link inputPolicy}
   *  (which primary actor drives the thread) — this is purely the operator-composer gate. */
  operatorInput: boolean;
  /** Which entity's tasks column this kind's task-tool calls fold into (`none` = not tracked). */
  taskScope: 'thread' | 'main' | 'none';
  /** How the kind's turn is invoked — a fresh bounded `execute-turn`, or a long-lived `session-backed`
   *  runtime the driver does not own (the brain's `main`, the Codex plan-review session). */
  runner: 'execute-turn' | 'session-backed';
  /** The child threads this kind materializes when it finishes executing (builder → lenses + post_review).
   *  Absent for leaf kinds. */
  children?: (parent: ThreadKindParent) => ThreadChildSpec[];
}
