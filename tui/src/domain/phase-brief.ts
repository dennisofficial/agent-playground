import { EPhaseKind } from "../generated/prisma/enums.js";

/**
 * The brief contract, split out of `phase-spec.ts` when the `generic` phase pushed that file past
 * the size cap. The split is along the only seam that was ever real: every brief module depends on
 * these types, and `PHASE_SPECS` depends on every brief module — so keeping both halves in one file
 * made the dependency a cycle that only type-erasure was hiding. Nothing here imports the table.
 */

/**
 * What the phase's prose is written against. The same phase kind is reachable from several places —
 * a `direct_build` opened cold to fix a red build and one opened off a fresh plan want different
 * opening words — and this context is what lets the vocabulary stay at nine phase kinds instead of
 * growing a `reship` kind for every re-entry.
 *
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
  /**
   * The pull request this job already has — the render cache `ship_pr` writes, not a live state.
   * Present means one was opened at some point, which is what makes a second `ci` phase's opening
   * words say *check before you open one*; it says nothing about whether it is still open or green,
   * because nothing local watches GitHub.
   */
  prNumber?: number;
};

/**
 * Two halves with two different lifetimes, deliberately returned together so one function owns the
 * phase's whole voice.
 *
 * `instructions` is standing: it rides the system prompt of EVERY turn in the phase, because the
 * system prompt is the only channel that survives a session rotation without being re-said.
 * `opening` is situational and said once, as the thread's first `harness` seed message — so it is
 * visible in the transcript, which is what makes "what was this thread told" auditable.
 *
 * A job's FIRST phase is the one place `opening` goes unsaid: `generic` opens on the human's own
 * message and nothing is seeded. It is still written, because start-a-phase can open a `generic`
 * phase on a job that already exists, and that thread has no human message to open on.
 */
export type PhaseBrief = {
  instructions: string;
  opening: string;
};

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
  prNumber?: number | null;
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
    ...(args.prNumber ? { prNumber: args.prNumber } : {}),
  };
}
