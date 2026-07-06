/**
 * thread-kind / registry — the ONE list of `ThreadKindSpec`s + the boot validation over it.
 *
 * Mirrors prompt-kit's `assemble.ts`: a plain, explicit list (no runtime discovery needed) that is
 * boot-validated LOUD (`validateThreadKinds`, the twin of `validateFragments`). Every `threads.kind` row
 * resolves through `threadKindSpec(kind)`; the driver's executable-section partition reads
 * `driverExecutableKinds` (kinds with `execution: 'top-level'`), and step 3 materializes children via
 * `spec.children`.
 */
import { Agent, renderAgentPrompt } from '../prompt-kit';
import { THREAD_REGISTRY } from '../surface/thread-registry';
import { DEFAULT_LENSES } from '../autofix/autofix-lenses';
import type { SessionEngine } from '../domain';
import type { CodexReasoningEffort } from '../engine';
import type { ThreadKindSpec, ThreadRowKind } from './spec';

/**
 * The shared Claude worker/brain model default — mirrors engine-core's `DEFAULT_WORKER_MODEL` and the
 * brain's `BRAIN_MODEL` (both the `'opus'` alias). Kept as a local literal because those live in
 * unexported engine internals; a divergence would only mislabel the pre-turn footer, never a real turn.
 */
const CLAUDE_DEFAULT_MODEL = 'opus';

/** Default fix-turn severity threshold for a builder's `post_review` child (matches AutoFixStage's default). */
const POST_REVIEW_MIN_SEVERITY = 'medium';

/**
 * THE thread-kind registry. One spec per kind; the driver + web read everything about a thread from here
 * instead of branching on `is_master_review` or hard-coding the lens fan-out.
 */
export const THREAD_KIND_SPECS: readonly ThreadKindSpec[] = [
  {
    // The job brain / operator conversation. A first-class row for the tree, but its runtime is the
    // AgentSessionManager session (`job_sandboxes.session_id`) — the driver NEVER executes it.
    kind: 'main',
    agent: Agent.ATLAS_MAIN,
    engine: 'claude',
    mode: 'conversational',
    execution: 'render-only',
    gates: { verification: false, liveVerification: false },
    laneKind: 'main',
    inputPolicy: 'operator',
    taskScope: 'main',
    runner: 'session-backed',
  },
  {
    // A build lane: one Claude WORKER execute turn owns the whole lane + its writer fan-out. Top-level
    // executable; after it verifies + commits it materializes its review children (step 3).
    kind: 'builder',
    agent: Agent.WORKER,
    engine: 'claude',
    mode: 'execute',
    execution: 'top-level',
    gates: { verification: true, liveVerification: true },
    laneKind: 'builder',
    inputPolicy: 'none',
    taskScope: 'thread',
    runner: 'execute-turn',
    children: () => [
      // One review_lens per default lens — each becomes its OWN row (no shared jsonb → no lost-update race).
      ...DEFAULT_LENSES.map((lens) => ({
        kind: 'review_lens' as ThreadRowKind,
        brief: lens.label,
        config: { lensId: lens.id },
      })),
      // The single fix pass that reads the sibling lenses' deduped findings and applies them.
      {
        kind: 'post_review' as ThreadRowKind,
        brief: 'Post-review fixes',
        config: { minSeverity: POST_REVIEW_MIN_SEVERITY },
      },
    ],
  },
  {
    // The ship-time whole-diff review: Codex, execute mode (reviews AND fixes), high reasoning effort, runs
    // LAST. It IS the review (carries its own verify mandate) so the host gates are off + it has no children.
    kind: 'master_review',
    agent: Agent.MASTER_REVIEW,
    engine: 'codex',
    mode: 'execute',
    execution: 'top-level',
    reasoningEffort: 'xhigh',
    gates: { verification: false, liveVerification: false },
    laneKind: 'builder',
    inputPolicy: 'none',
    taskScope: 'thread',
    runner: 'execute-turn',
  },
  {
    // One read-only review lens over its parent builder's diff. Driven as a CHILD; persists the FULL
    // ReviewFinding[] on its own row (`review_findings`) for post_review to read.
    kind: 'review_lens',
    agent: Agent.AUTOFIX_REVIEW,
    engine: 'claude',
    mode: 'review',
    execution: 'child',
    gates: { verification: false, liveVerification: false },
    laneKind: 'autofix-lens',
    inputPolicy: 'none',
    taskScope: 'none',
    runner: 'execute-turn',
  },
  {
    // The fix pass: one execute turn fed the deduped, severity-filtered findings off its sibling lenses.
    kind: 'post_review',
    agent: Agent.AUTOFIX_FIX,
    engine: 'claude',
    mode: 'execute',
    execution: 'child',
    gates: { verification: false, liveVerification: false },
    laneKind: 'autofix-fix',
    inputPolicy: 'none',
    taskScope: 'none',
    runner: 'execute-turn',
  },
  {
    // The synchronous Codex plan review. A render/identity-only row — its runtime stays in the brain's
    // `review_plan` tool + the `codex_reviews` work-owed source; the driver NEVER executes it.
    kind: 'plan_review',
    agent: Agent.META_PLAN_REVIEW,
    engine: 'codex',
    mode: 'review',
    // The plan reviewer reasons hard — the effort the `review_plan` turn actually runs at
    // (`plan-review.service.ts` reads it from here, single source of truth).
    reasoningEffort: 'xhigh',
    execution: 'render-only',
    gates: { verification: false, liveVerification: false },
    laneKind: 'codex-review',
    inputPolicy: 'agent',
    taskScope: 'none',
    runner: 'session-backed',
  },
];

const BY_KIND = new Map<string, ThreadKindSpec>(THREAD_KIND_SPECS.map((s) => [s.kind, s]));

/** The kinds the DRIVER's top loop executes as build sections (`builder` + `master_review`). Everything
 *  else is a child (`review_lens`/`post_review`) or render-only (`main`/`plan_review`). */
export const driverExecutableKinds: ReadonlySet<ThreadRowKind> = new Set(
  THREAD_KIND_SPECS.filter((s) => s.execution === 'top-level').map((s) => s.kind),
);

/** Resolve a kind's spec, or throw (an unknown kind is a bug — every row's kind is registry-backed). */
export function threadKindSpec(kind: string): ThreadKindSpec {
  const spec = BY_KIND.get(kind);
  if (!spec) throw new Error(`thread-kind: unknown kind "${kind}" (no ThreadKindSpec).`);
  return spec;
}

/** Is this kind driven by the driver's top loop (vs a child / render-only kind)? */
export function isDriverExecutableKind(kind: string): boolean {
  return driverExecutableKinds.has(kind as ThreadRowKind);
}

/** The static per-lane composer-footer default (`model · effort`), derived from the kind's spec. */
export interface LaneDefaultFooter {
  engine: SessionEngine;
  /** The Claude model id (`'opus'`) for claude kinds; omitted for codex (no pinned model). */
  model?: string;
  /** Codex reasoning effort, when the kind runs at one. */
  effort?: CodexReasoningEffort;
}

/**
 * The config-driven composer-footer default for a lane — what the footer shows BEFORE the lane's first
 * turn completes (so a fresh Main reads "Opus 4.8", a Codex review reads "Codex · xHigh"). Registry is the
 * single source: `engine`/`effort` come straight off the spec; `model` is the shared Claude default for
 * claude kinds (codex has no pinned model). Once a real `turn_meta` exists the web prefers it over this.
 */
export function laneDefaultFooter(kind: string): LaneDefaultFooter {
  const spec = threadKindSpec(kind);
  return {
    engine: spec.engine,
    ...(spec.engine === 'claude' ? { model: CLAUDE_DEFAULT_MODEL } : {}),
    ...(spec.reasoningEffort ? { effort: spec.reasoningEffort } : {}),
  };
}

/**
 * Fail LOUDLY on a misconfigured kind set (repo convention, twin of `validateFragments`): a duplicate
 * kind, an agent not in the `Agent` enum, a lane kind not in the `THREAD_REGISTRY`, a child that names an
 * unknown kind, and a smoke render of every kind's `Agent` prompt (surfaces a throwing fragment early).
 */
export function validateThreadKinds(specs: readonly ThreadKindSpec[] = THREAD_KIND_SPECS): void {
  const validAgents = new Set<string>(Object.values(Agent));
  const validLaneKinds = new Set<string>(THREAD_REGISTRY.map((d) => d.kind));
  const validKinds = new Set<string>(specs.map((s) => s.kind));
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.kind)) {
      throw new Error(`thread-kind: duplicate spec for kind "${s.kind}".`);
    }
    seen.add(s.kind);
    if (!validAgents.has(s.agent)) {
      throw new Error(`thread-kind: kind "${s.kind}" binds an unknown Agent "${s.agent}".`);
    }
    if (!validLaneKinds.has(s.laneKind)) {
      throw new Error(
        `thread-kind: kind "${s.kind}" names an unknown laneKind "${s.laneKind}" (not in THREAD_REGISTRY).`,
      );
    }
    // A `children` factory must only reference kinds that have a spec (so the materializer always resolves).
    if (s.children) {
      for (const child of s.children({ id: '(probe)', config: {} })) {
        if (!validKinds.has(child.kind)) {
          throw new Error(
            `thread-kind: kind "${s.kind}" declares a child of unknown kind "${child.kind}".`,
          );
        }
      }
    }
    // Smoke-render the kind's prompt (best-effort) — surfaces a throwing fragment at boot, not mid-build.
    try {
      renderAgentPrompt(s.agent, {});
    } catch (err) {
      throw new Error(
        `thread-kind: kind "${s.kind}" failed to render its Agent "${s.agent}" prompt: ${
          (err as Error).message
        }`,
      );
    }
  }
}
