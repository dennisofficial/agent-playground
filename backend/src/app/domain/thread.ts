/**
 * The work model. A THREAD is the unit of work: ONE intent (a feature or a bugfix) = one sandbox =
 * one worktree = one feature branch = ONE PR. A thread may stay a plain conversation (`open`) or enter
 * the build lifecycle. When it builds, it owns an ordered list of SECTIONS (e.g. backend → frontend →
 * devops); a bugfix is a 1-section / 1-phase build, a feature is many — same deterministic driver.
 * Sections stack on the one feature branch; phases run as sequential FRESH sessions on that branch.
 *
 * Two-level planning: (1) upfront, once — Atlas grills Dennis → a locked `DecisionRecord` + the
 * high-level section list, approved once; (2) per-section, just-in-time — a detailed phased plan, with
 * phases LOCKING once planned. The "dynamism" is the data (the list), not improvised control flow.
 *
 * These are the in-memory shapes (kept separate from the `threads` / `messages` / `sections` / `phases`
 * rows). Threads are isolated for context hygiene — cross-thread coherence is SHARED MEMORY only, never
 * transcript sharing; one `messages` table is partitioned by `thread_id`.
 */

/** Why a thread exists — a human-started chat, a notification-seeded thread, or an operator control action. */
export type ThreadOrigin = 'chat' | 'event' | 'control';

/**
 * A thread's build lifecycle. EXPLICIT, resumable status — NOT an implicit FSM re-derived from sibling
 * rows. A thread starts `open` (a conversation) and enters the build lifecycle when an intent is scoped.
 */
export type ThreadStatus =
  | 'open' // a conversation; no build scoped yet
  | 'scoping' // upfront grill in progress (no locked plan yet)
  | 'awaiting_approval' // decision record + section list posted; waiting on the operator
  | 'running' // sections executing
  | 'paused' // a turn hit a credential/401 error; the live session is saved, waiting on a re-ping to
  // resume (NOT auto-resumed on boot — it would just 401 again). Durable: the unfinished phase keeps its
  // `session_id`, so a ping continues the SAME session instead of starting from scratch.
  | 'done' // one PR opened, all sections handed off
  | 'failed'
  | 'cancelled';

/** Whether the thread builds a multi-section feature or a single-section bugfix — both run the same driver. */
export type ThreadKind = 'feature' | 'bugfix';

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
  /** The feature branch all sections stack on (null until the branch is cut). */
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

/** One section of a thread's build — a coherent slice (e.g. backend) that becomes a phased plan. */
export interface Section {
  /** Stable section id (`sections.id`). */
  id: string;
  /** The owning thread. */
  threadId: string;
  /** Execution order within the thread, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
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
  /** The owning thread (denormalized for thread-scoped boot recovery). */
  threadId: string;
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
