/**
 * The work model. A THREAD is the unit of work: ONE intent (a feature or a bugfix) = one sandbox =
 * one worktree = one feature branch = ONE PR. A thread may stay a plain conversation (`open`) or enter
 * the build lifecycle. When it builds, it owns an ordered list of TRACKS (e.g. backend → frontend →
 * devops); a bugfix is a 1-track / 1-step build, a feature is many — same deterministic driver.
 * Sections stack on the one feature branch; steps run as sequential FRESH sessions on that branch.
 *
 * Two-level planning: (1) upfront, once — Atlas grills Dennis → a locked `DecisionRecord` + the
 * high-level track list, approved once; (2) per-track, just-in-time — a detailed phased plan, with
 * steps LOCKING once planned. The "dynamism" is the data (the list), not improvised control flow.
 *
 * These are the in-memory shapes (kept separate from the `threads` / `messages` / `tracks` / `steps`
 * rows). Threads are isolated for context hygiene — cross-thread coherence is SHARED MEMORY only, never
 * transcript sharing; one `messages` table is partitioned by `thread_id`.
 */

// The thread lifecycle status is the WIRE CONTRACT with the web console, so it is single-sourced in
// `@workspace/shared` (see its doc comment for the per-value meanings). Imported for local use below
// and re-exported as the domain's `ThreadStatus` so the brain/driver keep importing it from `../domain`.
import type { ThreadStatus } from '@workspace/shared';
export type { ThreadStatus };

/** Why a thread exists — a human-started chat, a notification-seeded thread, or an operator control action. */
export type ThreadOrigin = 'chat' | 'event' | 'control';

/**
 * Whether a thread NEEDS THE OPERATOR — the single, server-owned definition of the sidebar "alert dot".
 *
 * A thread needs you when the AI is NOT actively working and is NOT in a terminal state: neither a live
 * conversational turn is streaming (`turnActive`) nor a build is running (`status='running'`) nor a plan
 * is under Codex review (`status='plan_review'`), and the thread hasn't finished (`done`/`cancelled`).
 * `turnActive` is a separate axis from `status` because
 * `status` alone can't tell "grilling, mid-turn" from "grilling, waiting on an answer" (both `planning`).
 *
 * `awaitingQuestion` is the third axis: a thread blocked on the durable human-input gate (a non-null
 * `awaiting_question_id` — the brain asked via `ask_question` and the answering turn has ended cleanly)
 * is DEFINITIONALLY waiting on the operator, so it overrides every other axis (the asking turn may have
 * briefly left `turn_active` set; the gate still wins).
 *
 * Derived — never stored — so there is exactly one rule, consumed by both the thread-list REST shape and
 * the realtime row mapper (they must never diverge).
 */
export function deriveNeedsYou(
  status: string,
  turnActive: boolean,
  awaitingQuestion: boolean,
): boolean {
  if (awaitingQuestion) return true;
  if (turnActive) return false;
  return (
    status !== 'running' &&
    status !== 'plan_review' &&
    status !== 'done' &&
    status !== 'cancelled'
  );
}

/**
 * Whether the thread builds a multi-track feature or a single-track bugfix (both run the same driver), or
 * is a one-off `'onboarding'` thread that initialises a newly-connected repo (the Atlas-run `claude init`:
 * discovers env/secrets/setup + authors `.atlas/worktree.json`). An onboarding thread never builds/PRs via
 * the driver — its tools are gated and it has its own mission prompt.
 */
export type ThreadKind = 'feature' | 'bugfix' | 'onboarding';

/** A conversation + (optionally) the build it drives. One intent, one branch, one PR. */
export interface Thread {
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
  kind: ThreadKind | null;
  status: ThreadStatus;
  /** The locked decision record's id (null until the upfront grill produces one). */
  decisionRecordId: string | null;
  /** The feature branch all tracks stack on (null until the branch is cut). */
  featureBranch: string | null;
  /** The opened PR url (null until the PR-tail stage opens one). */
  prUrl: string | null;
  /** The opened PR number — what the merge poll queries GitHub with (null until opened). */
  prNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One message in a thread's append-only log. */
export interface Message {
  /** Stable message id (`messages.id`). */
  id: string;
  /** The thread this message belongs to (the partition key). */
  threadId: string;
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

/** A track's lifecycle — explicit, resumable. The driver `await`s each transition. */
export type TrackStatus =
  | 'pending' // not started
  | 'planning' // detailed phased plan being generated
  | 'reviewing' // Codex plan-review loop
  | 'awaiting_approval' // an always-ask decision parked & asked async
  | 'executing' // steps running
  | 'auto_fixing' // per-track auto-fix stage
  | 'done'
  | 'failed';

/** One track of a thread's build — a coherent slice (e.g. backend) that becomes a phased plan. */
export interface Track {
  /** Stable track id (`tracks.id`). */
  id: string;
  /** The owning thread. */
  threadId: string;
  /** Execution order within the thread, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
  ordinal: number;
  /** The one-line brief from the upfront track list. */
  brief: string;
  /** The detailed just-in-time plan once generated (null while pending). */
  plan: string | null;
  /** The prior track's handoff note threaded into this track's plan prompt. */
  handoffIn: string | null;
  /** This track's handoff note for the next track (null until done). */
  handoffOut: string | null;
  status: TrackStatus;
}

/** A step's lifecycle — explicit, resumable; the driver re-enters at the correct step on restart. */
export type StepStatus =
  | 'pending'
  | 'building'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'skipped';

/**
 * One PHASE of a track's locked plan — runs as a fresh session on the feature branch (fresh context
 * per step keeps the window <300k and avoids hallucination; the shared checkout lets later steps
 * build on earlier code). `step` + `status` are the EXPLICIT resumable cursor — no implicit FSM.
 */
export interface Step {
  /** Stable step id (`steps.id`). */
  id: string;
  /** The owning track. */
  trackId: string;
  /** The owning thread (denormalized for thread-scoped boot recovery). */
  threadId: string;
  /** Execution order within the track, GAP-NUMBERED so a re-plan can splice. */
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
   * The execution batch this step belongs to within its track (consecutive steps packed into one
   * fresh-context session); null until the track first executes. Stable across restart so a resumed
   * batch re-groups identically.
   */
  batchOrdinal: number | null;
  /**
   * Set on the batch ANCHOR step when its batch commits — the resumable commit marker. Non-null means the
   * batch's work is already committed, so a resume FAST-FORWARDS (marks steps done) instead of re-running
   * against an already-committed tree. The sentinel `(nothing)` records "committed, empty diff". Null on
   * non-anchor steps and before commit.
   */
  commitSha: string | null;
}
