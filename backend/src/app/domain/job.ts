/**
 * The work model. A JOB is an ordered list of SECTIONS (e.g. backend → frontend → devops); a bugfix
 * is a 1-section / 1-phase job, a feature is many — same deterministic driver. Sections stack on ONE
 * feature branch inside one per-feature sandbox (MVP: a local git worktree). Phases run as sequential
 * fresh sessions on that branch.
 *
 * Two-level planning: (1) upfront, once — Atlas grills Dennis → a locked `DecisionRecord` + the
 * high-level section list, approved once; (2) per-section, just-in-time — a detailed phased plan,
 * with phases LOCKING once planned. The "dynamism" is the data (the list), not improvised control
 * flow. These are the in-memory shapes (kept separate from the `app` rows).
 */

/** A job's lifecycle. EXPLICIT, resumable status — NOT an implicit FSM re-derived from sibling rows. */
export type JobStatus =
  | 'scoping' // upfront grill in progress (no locked plan yet)
  | 'awaiting_approval' // decision record + section list posted; waiting on Dennis
  | 'running' // sections executing
  | 'paused' // a turn hit a credential/401 error; the live session is saved, waiting on a re-ping to
  // resume (NOT auto-resumed on boot — it would just 401 again). Durable: the unfinished phase keeps
  // its `session_id`, so a ping continues the SAME session instead of starting from scratch.
  | 'done' // one PR opened, all sections handed off
  | 'failed'
  | 'cancelled';

/** Whether the job is a multi-section feature or a single-section bugfix — both run the same driver. */
export type JobKind = 'feature' | 'bugfix';

/** One unit of work: a thread + a locked decision record + an ordered section list, on one branch. */
export interface Job {
  /** Stable job id (`jobs.id`). */
  id: string;
  /** The tenant (Slack team id). */
  orgId: string;
  /** The project this job builds against. */
  repoId: string;
  /** The thread the job's chatter lives in. */
  threadId: string;
  kind: JobKind;
  status: JobStatus;
  /** Short title (the feature/bugfix name). */
  title: string;
  /** The locked decision record's id (null until the upfront grill produces one). */
  decisionRecordId: string | null;
  /** The feature branch all sections stack on (null until the sandbox is cut). */
  featureBranch: string | null;
  /** The opened PR url (null until the PR-tail stage opens one). */
  prUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A section's lifecycle — explicit, resumable. The driver `await`s each transition. */
export type SectionStatus =
  | 'pending' // not started
  | 'planning' // detailed phased plan being generated
  | 'reviewing' // Codex plan-review loop
  | 'awaiting_approval' // an always-ask decision parked & asked async
  | 'executing' // phases running
  | 'auto_fixing' // per-section auto-fix stage
  | 'done'
  | 'failed';

/** One section of a job — a coherent slice (e.g. backend) that becomes a phased plan. */
export interface Section {
  /** Stable section id (`sections.id`). */
  id: string;
  /** The owning job. */
  jobId: string;
  /** Execution order within the job, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
  ordinal: number;
  /** The one-line brief from the upfront section list. */
  brief: string;
  /** The detailed just-in-time plan once generated (null while pending). */
  plan: string | null;
  /** The prior section's handoff note threaded into this section's plan prompt. */
  handoffIn: string | null;
  /** This section's handoff note for the next section (null until done). */
  handoffOut: string | null;
  status: SectionStatus;
}

/** A phase's lifecycle — explicit, resumable; the driver re-enters at the correct phase on restart. */
export type PhaseStatus =
  | 'pending'
  | 'building'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'skipped';

/**
 * One PHASE of a section's locked plan — runs as a fresh session on the feature branch (fresh context
 * per phase keeps the window <300k and avoids hallucination; the shared checkout lets later phases
 * build on earlier code). `step` + `status` are the EXPLICIT resumable cursor — no implicit FSM.
 */
export interface Phase {
  /** Stable phase id (`phases.id`). */
  id: string;
  /** The owning section. */
  sectionId: string;
  /** The owning job (denormalized for job-scoped boot recovery). */
  jobId: string;
  /** Execution order within the section, GAP-NUMBERED so a re-plan can splice. */
  ordinal: number;
  /** The phase title from the plan. */
  title: string | null;
  /** The phase brief/instructions from the locked plan. */
  brief: string;
  /**
   * The explicit resumable STEP within the phase — the deterministic driver re-enters here after a
   * restart instead of re-deriving control flow from statuses. E.g. 'build' | 'review' | 'fix'.
   */
  step: string;
  status: PhaseStatus;
  /** The engine session this phase runs in (`SessionRef.id`); null until started. */
  sessionId: string | null;
}
