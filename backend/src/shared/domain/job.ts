/**
 * The work model. A THREAD is the unit of work: ONE intent (a feature or a bugfix) = one sandbox =
 * one worktree = one feature branch = ONE PR. A thread may stay a plain conversation (`open`) or enter
 * the build lifecycle. When it builds, it owns an ordered list of THREADS (e.g. backend → frontend →
 * devops); a bugfix is a 1-thread / 1-step build, a feature is many — same deterministic driver.
 * Sections stack on the one feature branch; steps run as sequential FRESH sessions on that branch.
 *
 * Two-level planning: (1) upfront, once — Atlas grills Dennis → a locked `DecisionRecord` + the
 * high-level thread list, approved once; (2) per-thread, just-in-time — a detailed phased plan, with
 * steps LOCKING once planned. The "dynamism" is the data (the list), not improvised control flow.
 *
 * These are the in-memory shapes (kept separate from the `threads` / `messages` / `threads` / `steps`
 * rows). Threads are isolated for context hygiene — cross-thread coherence is SHARED MEMORY only, never
 * transcript sharing; one `messages` table is partitioned by `job_id`.
 */

// The thread lifecycle status is the WIRE CONTRACT with the web console, so it is single-sourced in
// `@workspace/shared` (see its doc comment for the per-value meanings). Imported for local use below
// and re-exported as the domain's `JobStatus` so the brain/driver keep importing it from `../domain`.
import type { JobStatus, AutoApproveMode } from '@workspace/shared';
// Type-only: `thread-types.ts` imports nothing, so this is cycle-free even though `thread-kind`'s
// registry imports from `autofix`, which imports domain types.
import type { ThreadType } from '../thread-kind/thread-types';
export type { JobStatus };

/**
 * VESTIGIAL job-level halt marker. The job-level halt/activity axes were removed from the schema (a thread
 * halting never halts the JOB row; `status` alone carries phase, and per-thread display state now lives on
 * `thread.halt_reason`). This minimal shape is retained ALWAYS-NULL so the driver/brain's transitional
 * halt-guard reads keep compiling until those paths are collapsed in a later slice. Nothing ever writes it.
 */
export type JobHalt = { kind: string };

/** Why a thread exists — a human-started chat, a notification-seeded thread, or an operator control action. */
export type ThreadOrigin = 'chat' | 'event' | 'control';

/** Immutable provenance snapshot of the job that spawned this one, captured at create time. */
export type JobProvenance = { jobId: string; title: string | null };

// Phases the job is DEAD in — never a needs-you state (it is going away or already finished).
const TERMINAL_STATUSES = new Set(['merged', 'cancelled', 'deleting']);
// Phases whose next step is the OPERATOR's: an idle job sitting here is waiting on the human.
// ('blocked' is deliberately NOT here — it's a dependency park the system owns, not a human ask.)
const OPERATOR_OWNED_STATUSES = new Set([
  'awaiting_approval',
  'ready',
  'amending',
]);

/**
 * Whether a thread NEEDS THE OPERATOR — the single, server-owned definition of the sidebar "alert dot".
 * Derived, never stored, so there is exactly ONE rule, consumed by both the REST thread-list and the
 * realtime row mapper (they must never diverge).
 *
 * The job `status` alone carries the phase (the old `activity`/`halt` axes are gone). Terminal phases
 * never light the dot; the OPERATOR-owned phases (the human is the next actor) always do; `blocked` is a
 * dependency park the system owns, so it never lights it. For every other (system-owned) phase the dot
 * lights only when a durable human-input gate is open — an unanswered `ask_question` (`openQuestion`) or
 * an outstanding secret request (`awaitingSecret`).
 */
export function deriveNeedsYou(i: {
  status: string;
  openQuestion: boolean;
  awaitingSecret: boolean;
}): boolean {
  if (TERMINAL_STATUSES.has(i.status)) return false;
  if (i.status === 'blocked') return false;
  if (OPERATOR_OWNED_STATUSES.has(i.status)) return true;
  return i.openQuestion || i.awaitingSecret;
}

/**
 * Whether the thread builds a multi-thread feature or a single-thread bugfix (both run the same driver), or
 * is a one-off `'onboarding'` thread that initialises a newly-connected repo (the Atlas-run `claude init`:
 * discovers env/secrets/setup + authors `.atlas/worktree.json`). An onboarding thread never builds/PRs via
 * the driver — its tools are gated and it has its own mission prompt. `'event'` is a job seeded by an
 * external notification/CI signal (see the stimulus firehose) — untrusted intake, not an operator-shaped build.
 * `'review'` reviews an EXISTING external pull request (never builds/PRs of its own) — it fetches the PR
 * diff and posts findings; unlike the build kinds it can be picked by the operator at job creation.
 */
export type JobKind = 'feature' | 'bugfix' | 'onboarding' | 'event' | 'review';

/** A conversation + (optionally) the build it drives. One intent, one branch, one PR. */
export interface Job {
  /** Stable thread id (`threads.id`). */
  id: string;
  /** The tenant (org id). */
  orgId: string;
  /** The repo this thread builds against (`repos.id`). */
  repoId: string;
  /** What opened the thread. */
  origin: ThreadOrigin;
  /** The surface-native thread coordinate (e.g. the root message ts); null until posted. */
  surfaceThreadRef: string | null;
  /** Short human-readable label (the feature/notification title). */
  title: string | null;
  /** The base branch the build cuts from (operator-picked; null → repo default). */
  baseBranch: string | null;
  /** Build intent; null until the thread enters the build lifecycle. */
  kind: JobKind | null;
  /** The committed build path ('direct' | 'plan'); null until an approval commits it (see `approve`). */
  buildPath: 'direct' | 'plan' | null;
  status: JobStatus;
  /** Vestigial always-null job-level halt marker (see {@link JobHalt}) — nothing writes it; retained only
   *  so the driver/brain's transitional halt-guard reads keep compiling. */
  halt: JobHalt | null;
  /** The locked decision record's id (null until the upfront grill produces one). */
  decisionRecordId: string | null;
  /** The feature branch all threads stack on (null until the branch is cut). */
  featureBranch: string | null;
  /** The OBSERVED live branch the sandbox HEAD is on (sampled from the agent's git activity); null until
   *  first sampled / on detached HEAD. Divergence from {@link featureBranch} is DRIFT (surfaced, not blocked). */
  currentBranch: string | null;
  /** The opened PR url (null until the PR-tail thread group opens one). */
  prUrl: string | null;
  /** The opened PR number — what the merge poll queries GitHub with (null until opened). */
  prNumber: number | null;
  /** The ship-review gate marker: set when the operator clicked "Ship it", null otherwise. The driver's
   *  ship gate reads it to distinguish "just parked" (null → park at `awaiting_ship_review`) from
   *  "approved, proceed" (set → ship). Cleared when a new build is dispatched. See {@link JobStatus}. */
  shipReviewApprovedAt: Date | null;
  /** Per-job auto-approve mode: which gates auto-advance with no human click (see jobs.auto_approve_mode). */
  autoApproveMode: AutoApproveMode;
  /** Who enabled auto-approve (users.id), used as the approver on auto-resolve; null if never enabled
   *  / enabling user deleted. */
  autoApproveBy: string | null;
  /** Per-job AUTO-MERGE master toggle: when on, a merge-ready PR auto-merges. See jobs.auto_merge. */
  autoMerge: boolean;
  /** Who most recently enabled auto-merge (users.id); null if never enabled / user deleted. */
  autoMergeBy: string | null;
  /** Who spawned this job (immutable snapshot), or null for top-level jobs. */
  createdBy: JobProvenance | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One message in a thread's append-only log. */
export interface TranscriptMessage {
  /** Stable message id (`messages.id`). */
  id: string;
  /** The thread this message belongs to (the partition key). */
  jobId: string;
  /** Author display name ("Dennis", "Atlas"). */
  author: string;
  /** Author scope id ("dennis", "atlas"). */
  authorId: string;
  /** Set when Atlas (the brain) authored it. */
  authorBotId: string | null;
  /** The message body. */
  text: string;
  createdAt: Date;
}

/** How long a master_review Codex-outage hold waits before the resume sweep re-attempts the Codex review. */
export const CODEX_REVIEW_OUTAGE_RETRY_MS = 5 * 60_000;

/** A thread's collapsed lifecycle cursor. `idle` is the dormant/resumable resting state (subsumes the old
 *  pending/planning/reviewing/executing/auto_fixing steps); `done` means the thread's `terminal_record` is
 *  present. Mirrors {@link ThreadEntity.status}. */
export type ThreadStatus = 'idle' | 'done';

/** A lightweight denormalized overlay tag on a thread (like job-level `halt.kind`), ORTHOGONAL to the
 *  linear {@link ThreadStatus} step: it records the pause/terminal CONDITION without moving the step.
 *  Detail (stderr, block reason, verification) stays in `terminal_record`/`halt_outcome`. */
export type ThreadCondition =
  | 'none'
  | 'paused'
  | 'incomplete'
  | 'failed'
  | 'skipped';

/** One thread of a thread's build — a coherent slice (e.g. backend) that becomes a phased plan. */
export interface Thread {
  /** Stable thread id (`threads.id`). */
  id: string;
  /** The owning thread. */
  jobId: string;
  /** Execution order within the thread, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
  ordinal: number;
  /** The one-line brief from the upfront thread list. */
  brief: string;
  /** The detailed just-in-time plan once generated (null while pending). */
  plan: string | null;
  /**
   * A compact repo-orientation cheat-sheet the plan turn captured (repo layout + the REAL verify commands),
   * handed to the FRESH builder session so it need not rediscover the repo blind. Null while pending, or on
   * resume of a thread planned before this field existed (the builder then orients off the repo docs itself).
   */
  orientation: string | null;
  /** The prior thread's handoff note threaded into this thread's plan prompt. */
  handoffIn: string | null;
  /** This thread's handoff note for the next thread (null until done). */
  handoffOut: string | null;
  status: ThreadStatus;
  /** The orthogonal condition overlay (pause/terminal tag) — independent of the linear {@link status} step. */
  condition: ThreadCondition;
  /** The thread KIND — `main | builder | master_review | review_lens | post_review | plan_review`. The
   *  single differentiator across all thread-like concepts (a `master_review` is the whole-diff Codex
   *  review-&-fix appended last). See {@link ThreadEntity.kind}. */
  kind: string;
  /** The owning thread group (`threads.thread_group_id`) — the rotation-stable grain a build's legs share.
   *  Every thread row belongs to exactly one group. See {@link ThreadEntity.thread_group_id}. */
  threadGroupId: string;
  /** The scope TYPE (`backend | frontend | docs | testing | infra | data | general`) — the deterministic
   *  routing key `reviewAgentsForThread` selects review lenses on. See {@link ThreadEntity.type}. */
  type: ThreadType;
  /** The parent thread in the tree (a builder is the parent of its review-lens/post-review children);
   *  null for root/job-level rows. See {@link ThreadEntity.parent_thread_id}. */
  parentThreadId: string | null;
  /** The thread's START HEAD (feature-branch sha) captured once at first execute and persisted, so a resume
   *  reuses the true base for the review diff (`startSha..HEAD`) + commit-recording instead of re-capturing
   *  it post-commit (which would collapse the range to empty). Null until first execute. See
   *  {@link ThreadEntity.start_sha}. */
  startSha: string | null;
}

/** A step's lifecycle — explicit, resumable; the driver re-enters at the correct step on restart. */
export type StepStatus = 'pending' | 'building' | 'reviewing' | 'done';

/**
 * One PHASE of a thread's locked plan — runs as a fresh session on the feature branch (fresh context
 * per step keeps the window <300k and avoids hallucination; the shared checkout lets later steps
 * build on earlier code). `step` + `status` are the EXPLICIT resumable cursor — no implicit FSM.
 */
export interface Step {
  /** Stable step id (`steps.id`). */
  id: string;
  /** The owning thread. */
  threadId: string;
  /** The owning thread (denormalized for thread-scoped boot recovery). */
  jobId: string;
  /** Execution order within the thread, GAP-NUMBERED so a re-plan can splice. */
  ordinal: number;
  /** The step title from the plan. */
  title: string | null;
  /** The step brief/instructions from the locked plan. */
  brief: string;
  /**
   * The explicit resumable STEP within the step — the deterministic driver re-enters here after a
   * restart instead of re-deriving control flow from statuses. E.g. 'build' | 'review' | 'fix'.
   */
  stage: string;
  status: StepStatus;
  /** The engine session this step runs in (`SessionRef.id`); null until started. */
  sessionId: string | null;
  /**
   * The execution batch this step belongs to within its thread (consecutive steps packed into one
   * fresh-context session); null until the thread first executes. Stable across restart so a resumed
   * batch re-groups identically.
   */
  batchOrdinal: number | null;
  /**
   * Which Leg (1..N) the anchor step's build session is currently on — incremented on each rotation. Stamped
   * into build-turn `meta.legOrdinal` so the web slices the thread transcript per Leg (each Leg = its own
   * thread node). Defaults to 1 for a step that has never rotated.
   */
  legOrdinal: number;
  /**
   * Set on the batch ANCHOR step when its batch commits — the resumable commit marker. Non-null means the
   * batch's work is already committed, so a resume FAST-FORWARDS (marks steps done) instead of re-running
   * against an already-committed tree. The sentinel `(nothing)` records "committed, empty diff". Null on
   * non-anchor steps and before commit.
   */
  commitSha: string | null;
}
