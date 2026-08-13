import { EPhaseKind, EThreadRole } from "../generated/prisma/enums.js";
import { chartingBrief } from "./charting-brief.js";
import { genericBrief } from "./generic-brief.js";
import type { ContextBucket } from "./paths.js";
import type { PhaseBrief, PhaseBriefContext } from "./phase-brief.js";
import {
  buildBrief,
  ciBrief,
  designBrief,
  directBuildBrief,
  masterReviewBrief,
  planningBrief,
  postBuildBrief,
} from "./phase-briefs.js";

/*
 * There is deliberately no per-phase confirm setting.
 *
 * EVERY phase transition goes through the confirm screen. An earlier cut let `build`,
 * `direct_build` and `master_review` exit without asking, on the argument that an ask carrying no
 * information trains `y` as a reflex. What that missed is that the exits it exempted are not all
 * uninformative: `build → planning` is the plan turning out to be wrong, which is exactly the fork
 * a human should see, and reading the setting off the phase being LEFT could not tell that edge
 * apart from `build → master_review`.
 *
 * The field is gone rather than set to `ask` everywhere, because a one-valued setting is an
 * invitation to reintroduce the fork. If confirmation should ever vary again, it varies by EDGE —
 * not by phase — and that is a different shape.
 */

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
   * a `charting` thread. Do not resurrect the inverse.
   */
  roles: readonly EThreadRole[];
  /**
   * The graph, in menu order. It rails the AGENT — it becomes the enum on `advance_phase` — and
   * never the human, who was never railed by it. Every edge is unconditional; the conditional
   * `build → master_review (if …)` was what splitting `build` and `direct_build` bought out.
   */
  next: readonly EPhaseKind[];
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
const CHARTING_FLOOR = unnumberedIn("charting");
const SPECS_FLOOR = unnumberedIn("specs");

export const PHASE_SPECS: Record<EPhaseKind, PhaseSpec> = {
  // Every job's first phase, and the only kind that names an absence rather than an activity: a
  // generic coding agent, the way a regular session is. The stance is earned by the work rather than
  // assumed at creation, and the agent's judgement about WHEN to escalate is the feature.
  //
  // NOTHING points at `generic` — no other phase's `next` contains it. Returning to un-postured
  // conversation is a human judgement, and start-a-phase already reaches any phase; `next` means
  // "what the agent may propose", never "what is legal". `attach` is the ordinary floor rather than
  // an empty function: empty by construction on a fresh job, and it hands over `map.md` on a job
  // re-entered after charting. One rule, two behaviours, no special case.
  generic: {
    kind: EPhaseKind.generic,
    roles: [
      EThreadRole.generic,
      EThreadRole.research,
      EThreadRole.prototype,
      EThreadRole.task,
    ],
    next: [EPhaseKind.charting, EPhaseKind.planning],
    brief: genericBrief,
    attach: CHARTING_FLOOR,
  },
  // Charting is wayfinder: it clears fog on WHAT this is and whether it is worth doing, and ends when
  // the destination can be written honestly. Its roles are wayfinder's ticket types.
  charting: {
    kind: EPhaseKind.charting,
    roles: [
      EThreadRole.charting,
      EThreadRole.research,
      EThreadRole.prototype,
      EThreadRole.task,
    ],
    next: [EPhaseKind.planning, EPhaseKind.design],
    brief: chartingBrief,
    attach: CHARTING_FLOOR,
  },
  // Parked and human-in-the-loop by design: the work happens outside Atlas. A design thread writes
  // a handoff, Dennis runs Claude Design himself, and attaches the bundle back into `artifacts/`.
  design: {
    kind: EPhaseKind.design,
    roles: [EThreadRole.designer, EThreadRole.prototype],
    next: [EPhaseKind.planning],
    brief: designBrief,
    attach: CHARTING_FLOOR,
  },
  // `charting` is in planning's roles on purpose: there is no `planning → charting` back-edge, because
  // `advance_phase` throws unless you are the last open thread — a back-edge would force the planner
  // to destroy its own context to ask one question. It opens a charting thread beside itself instead.
  planning: {
    kind: EPhaseKind.planning,
    roles: [
      EThreadRole.planner,
      EThreadRole.plan_review,
      EThreadRole.charting,
      EThreadRole.research,
      EThreadRole.prototype,
    ],
    next: [EPhaseKind.build, EPhaseKind.direct_build, EPhaseKind.design],
    brief: planningBrief,
    attach: CHARTING_FLOOR,
  },
  // The thorough path: review children on close, and the wave always goes to master review. The
  // backward edge to planning is for a builder that finds the plan wrong while the discovery is fresh.
  build: {
    kind: EPhaseKind.build,
    roles: [EThreadRole.builder],
    next: [EPhaseKind.master_review, EPhaseKind.planning],
    // Exits on its own: master review is the one natural successor and there is nothing to eyeball
    // that master review is not about to look at anyway. The back-edge to `planning` rides the same
    // rule and IS a fork taken without a keypress — the one auto exit that has one. Recorded rather
    // than special-cased: if a builder re-planning unasked turns out to be wrong, the fix is to make
    // confirmation a function of the edge, not to bolt a condition onto this phase.
    brief: buildBrief,
    attach: SPECS_FLOOR,
  },
  // The fast path: same activity as `build`, different closing policy — no review children, no
  // master review. Two kinds rather than a flag is what removed every conditional edge from the graph.
  direct_build: {
    kind: EPhaseKind.direct_build,
    roles: [EThreadRole.builder],
    next: [EPhaseKind.post_build],
    // One successor, mechanical signal, nothing to look at yet — the review happens in post_build.
    brief: directBuildBrief,
    attach: SPECS_FLOOR,
  },
  master_review: {
    kind: EPhaseKind.master_review,
    roles: [EThreadRole.master_review],
    next: [EPhaseKind.post_build],
    // Its whole output is a report Dennis is about to read in post_build; asking here would be a
    // keystroke between him and the same information.
    brief: masterReviewBrief,
    attach: SPECS_FLOOR,
  },
  post_build: {
    kind: EPhaseKind.post_build,
    roles: [EThreadRole.post_build],
    next: [EPhaseKind.planning, EPhaseKind.design, EPhaseKind.ci],
    brief: postBuildBrief,
    attach: SPECS_FLOOR,
  },
  // Absorbing: nothing terminates a job, and no exit is offered to the agent. Re-entry after a red
  // build is the HUMAN starting a phase — the graph is an affordance and was never a rail on him —
  // so an empty `next` must be read as "nothing to propose", never as "nothing is legal".
  ci: {
    kind: EPhaseKind.ci,
    // Two roles, and the second one has no writer yet on purpose: `ship_pr` is what the phase opens
    // with, and `ci` is the thread Dennis opens by hand when something comes back red. `ci` is kept
    // NAMED rather than folded into `builder` because it is the routing target for when webhooks
    // eventually land — an event needs a role to be delivered to, and minting one at that point
    // would be a migration.
    roles: [EThreadRole.ship_pr, EThreadRole.ci],
    next: [],
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

/** The brief for a phase, in one call — the only door the app layer needs. */
export function briefFor(ctx: PhaseBriefContext): PhaseBrief {
  return PHASE_SPECS[ctx.kind].brief(ctx);
}
