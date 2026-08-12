import { EPhaseKind, EThreadRole } from "../generated/prisma/enums.js";
import { intakeBrief } from "./intake-brief.js";
import type { ContextBucket } from "./paths.js";
import {
  buildBrief,
  ciBrief,
  designBrief,
  directBuildBrief,
  masterReviewBrief,
  planningBrief,
  postBuildBrief,
} from "./phase-briefs.js";

/**
 * Whether ENTERING this phase waits on the human. Phase boundaries are human boundaries, so every
 * phase asks today — the field exists because entry confirmation is a property of the phase you are
 * entering rather than a global rule, and because a confirmation that never varies is one nobody
 * reads. `auto` is declared so that a phase which earns it later is a one-word edit here, and it is
 * deliberately not a dial anyone can turn from outside this file.
 */
export enum EPhaseConfirm {
  ask = "ask",
  auto = "auto",
}

/**
 * What the phase's prose is written against. The same phase kind is reachable from several places —
 * a `direct_build` opened cold to fix a red build and one opened off a fresh plan want different
 * opening words — and this context is what lets the vocabulary stay at eight phase kinds instead of
 * growing a `reship` kind for every re-entry.
 *
 * No pull-request field: nothing writes one yet. `ci` will want it the moment `ship_pr` exists, and
 * adding it then is one line in `phaseBriefContext` — inventing it now would be a field with a
 * reader and no writer, which is how `generated/` and `EThreadStatus.pending` died.
 */
export type PhaseBriefContext = {
  kind: EPhaseKind;
  /** 0 is the phase the job opened in. Phases are appended, never reordered. */
  ordinal: number;
  /** The phase this one came out of; absent only on the job's first phase. */
  previous?: EPhaseKind;
  /** This kind has run on this job before — a second `ci`, a `direct_build` chasing a red build. */
  repeat: boolean;
  /** What the human called the job, which is the only statement of intent that predates every thread. */
  jobTitle: string;
  /**
   * The job's context folder, absolute. Interpolated into the prose rather than left as
   * `$ATLAS_CONTEXT_DIR`, because `Read`/`Write`/`Edit` take a literal path with no shell expansion
   * — the agent has to be able to copy a string it can see.
   */
  contextRoot: string;
  /** The job's branch, when it took one. */
  branch?: string;
};

/**
 * Two halves with two different lifetimes, deliberately returned together so one function owns the
 * phase's whole voice.
 *
 * `instructions` is standing: it rides the system prompt of EVERY turn in the phase, because the
 * system prompt is the only channel that survives a session rotation without being re-said.
 * `opening` is situational and said once, as the thread's first `harness` seed message — so it is
 * visible in the transcript, which is what makes "what was this thread told" auditable.
 */
export type PhaseBrief = {
  instructions: string;
  opening: string;
};

/** A file in the job's context folder, named the way the folder names it: bucket plus relative path. */
export type ContextFileRef = {
  bucket: ContextBucket;
  path: string;
};

/**
 * The pipeline, declared once.
 *
 * A hardcoded TS object and not a table: it is a tuning surface edited in an editor, and a table
 * would need a seeder and a migration to change a prompt. Same reasoning that bakes wayfinder into
 * the system prompt rather than loading a skill file.
 *
 * Deliberately NOT built: no pipeline wrapper, no registry, no pipeline id, no outer key for a
 * second workflow. Adding one when a second pipeline actually exists is a two-line change; adding
 * it now is scaffolding for a workflow nobody has asked for.
 */
export type PhaseSpec = {
  kind: EPhaseKind;
  /**
   * Every role this phase may host — the ONLY list of roles in the app. It is the enum on the
   * agent's `open_thread`/`advance_thread`, and the same list the human's "open a thread here" menu
   * offers. A phase that should forbid threads declares none and forbids them by construction, so
   * there is no `allowHumanThreads` flag. `ROLE_GROUP` (role → phase) was deleted for this: it
   * assumed a role belongs to one phase, which stopped being true the moment `planning` could host
   * an `intake` thread. Do not resurrect the inverse.
   */
  roles: readonly EThreadRole[];
  /**
   * The graph, in menu order. It rails the AGENT — it becomes the enum on `advance_phase` — and
   * never the human, who was never railed by it. Every edge is unconditional; the conditional
   * `build → master_review (if …)` was what splitting `build` and `direct_build` bought out.
   */
  next: readonly EPhaseKind[];
  confirm: EPhaseConfirm;
  brief: (ctx: PhaseBriefContext) => PhaseBrief;
  /**
   * The structural floor of what a thread entering this phase is handed: every UNNUMBERED file in
   * the bucket this phase reads. A function over the folder rather than a list of filenames,
   * because `specs/` is dynamic — the planner declares what is shared by choosing a filename, and
   * a list here would have to be maintained against a decision made elsewhere.
   *
   * Pure, and takes the listing rather than reading it: `domain/` has no filesystem. The caller
   * inlines the bodies — `Read` truncates silently, and a handoff missing its tail is a failure
   * nobody sees. The agent adds what is situational on top of this floor.
   */
  attach: (files: readonly ContextFileRef[]) => readonly ContextFileRef[];
};

/**
 * Numbered files are one thread's; unnumbered files are everyone's. The filename carries scope
 * because the `NN-` prefix was already load-bearing for identity, and the two agree — a numbered
 * thing is claimable by exactly one thread, so flooring it into every thread would be wrong.
 *
 * Nested paths are skipped: both buckets are flat by contract, so anything under a directory is a
 * bundle somebody deliberately grouped, and `artifacts/` — never floored at all — is where those
 * live.
 */
function unnumberedIn(bucket: ContextBucket) {
  return (files: readonly ContextFileRef[]): readonly ContextFileRef[] =>
    files.filter(
      (file) =>
        file.bucket === bucket &&
        !file.path.includes("/") &&
        !/^\d+[-_]/.test(file.path),
    );
}

/** `artifacts/` is never floored — nested bundles, inherently situational, always agent-declared. */
const INTAKE_FLOOR = unnumberedIn("intake");
const SPECS_FLOOR = unnumberedIn("specs");

export const PHASE_SPECS: Record<EPhaseKind, PhaseSpec> = {
  // Intake is wayfinder: it clears fog on WHAT this is and whether it is worth doing, and ends when
  // the destination can be written honestly. Its roles are wayfinder's ticket types.
  intake: {
    kind: EPhaseKind.intake,
    roles: [
      EThreadRole.intake,
      EThreadRole.research,
      EThreadRole.prototype,
      EThreadRole.task,
    ],
    next: [EPhaseKind.planning, EPhaseKind.design],
    confirm: EPhaseConfirm.ask,
    brief: intakeBrief,
    attach: INTAKE_FLOOR,
  },
  // Parked and human-in-the-loop by design: the work happens outside Atlas. A design thread writes
  // a handoff, Dennis runs Claude Design himself, and attaches the bundle back into `artifacts/`.
  design: {
    kind: EPhaseKind.design,
    roles: [EThreadRole.designer, EThreadRole.prototype],
    next: [EPhaseKind.planning],
    confirm: EPhaseConfirm.ask,
    brief: designBrief,
    attach: INTAKE_FLOOR,
  },
  // `intake` is in planning's roles on purpose: there is no `planning → intake` back-edge, because
  // `advance_phase` throws unless you are the last open thread — a back-edge would force the planner
  // to destroy its own context to ask one question. It opens an intake thread beside itself instead.
  planning: {
    kind: EPhaseKind.planning,
    roles: [
      EThreadRole.planner,
      EThreadRole.plan_review,
      EThreadRole.intake,
      EThreadRole.research,
      EThreadRole.prototype,
    ],
    next: [EPhaseKind.build, EPhaseKind.direct_build, EPhaseKind.design],
    confirm: EPhaseConfirm.ask,
    brief: planningBrief,
    attach: INTAKE_FLOOR,
  },
  // The thorough path: review children on close, and the wave always goes to master review. The
  // backward edge to planning is for a builder that finds the plan wrong while the discovery is fresh.
  build: {
    kind: EPhaseKind.build,
    roles: [EThreadRole.builder],
    next: [EPhaseKind.master_review, EPhaseKind.planning],
    confirm: EPhaseConfirm.ask,
    brief: buildBrief,
    attach: SPECS_FLOOR,
  },
  // The fast path: same activity as `build`, different closing policy — no review children, no
  // master review. Two kinds rather than a flag is what removed every conditional edge from the graph.
  direct_build: {
    kind: EPhaseKind.direct_build,
    roles: [EThreadRole.builder],
    next: [EPhaseKind.post_build],
    confirm: EPhaseConfirm.ask,
    brief: directBuildBrief,
    attach: SPECS_FLOOR,
  },
  master_review: {
    kind: EPhaseKind.master_review,
    roles: [EThreadRole.master_review],
    next: [EPhaseKind.post_build],
    confirm: EPhaseConfirm.ask,
    brief: masterReviewBrief,
    attach: SPECS_FLOOR,
  },
  post_build: {
    kind: EPhaseKind.post_build,
    roles: [EThreadRole.post_build],
    next: [EPhaseKind.planning, EPhaseKind.design, EPhaseKind.ci],
    confirm: EPhaseConfirm.ask,
    brief: postBuildBrief,
    attach: SPECS_FLOOR,
  },
  // Absorbing: nothing terminates a job, and no exit is offered to the agent. Re-entry after a red
  // build is the HUMAN starting a phase — the graph is an affordance and was never a rail on him —
  // so an empty `next` must be read as "nothing to propose", never as "nothing is legal".
  ci: {
    kind: EPhaseKind.ci,
    roles: [EThreadRole.ci],
    next: [],
    confirm: EPhaseConfirm.ask,
    brief: ciBrief,
    attach: SPECS_FLOOR,
  },
};

export function phaseSpecFor(kind: EPhaseKind): PhaseSpec {
  return PHASE_SPECS[kind];
}

/** The roles a thread may be opened with here — agent tool enum and human menu, one list. */
export function rolesFor(kind: EPhaseKind): readonly EThreadRole[] {
  return PHASE_SPECS[kind].roles;
}

/** What the agent may propose from here. Empty is a real answer: `ci` proposes nothing. */
export function nextPhasesFor(kind: EPhaseKind): readonly EPhaseKind[] {
  return PHASE_SPECS[kind].next;
}

export function phaseLabel(kind: EPhaseKind): string {
  return kind.replace(/_/g, " ");
}

type PhaseRow = { id: string; kind: EPhaseKind; ordinal: number };

/**
 * The context a brief is written against, assembled from the job's phase list.
 *
 * Pure so the "is this a repeat" and "what preceded it" decisions are testable without a database —
 * they are read off ordinals rather than stored, because a phase list is append-only and therefore
 * already says both.
 */
export function phaseBriefContext(args: {
  phases: readonly PhaseRow[];
  phaseId: string;
  jobTitle: string;
  contextRoot: string;
  branch?: string | null;
}): PhaseBriefContext {
  const ordered = [...args.phases].sort((a, b) => a.ordinal - b.ordinal);
  const index = ordered.findIndex((phase) => phase.id === args.phaseId);
  const phase = ordered[index];
  if (!phase) throw new Error(`phase ${args.phaseId} is not on this job`);

  const previous = index > 0 ? ordered[index - 1] : undefined;
  const repeat = ordered
    .slice(0, index)
    .some((earlier) => earlier.kind === phase.kind);

  return {
    kind: phase.kind,
    ordinal: phase.ordinal,
    ...(previous ? { previous: previous.kind } : {}),
    repeat,
    jobTitle: args.jobTitle,
    contextRoot: args.contextRoot,
    ...(args.branch ? { branch: args.branch } : {}),
  };
}

/** The brief for a phase, in one call — the only door the app layer needs. */
export function briefFor(ctx: PhaseBriefContext): PhaseBrief {
  return PHASE_SPECS[ctx.kind].brief(ctx);
}
