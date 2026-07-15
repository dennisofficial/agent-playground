/**
 * thread-group-kind / spec — the `ThreadGroupKindSpec`: one declarative descriptor per thread-group KIND,
 * the first-class §N pipeline grouping (d2/d7). Mirrors `thread-kind/spec.ts` (behavior lives in the
 * registry, not on the row, d8) — a job's pipeline is the ordinal-ordered sequence of its thread groups,
 * and every thread group's shape (which roles it contains, whether it reviews, when it spawns) is
 * declared here, consumed by the orchestration layer (thread 3) rather than branched on inline.
 */
import type { ThreadRole } from '../thread-kind/spec';

/** The KIND of a `ThreadGroupEntity` row — the single differentiator across every pipeline grouping. */
export type ThreadGroupKind =
  | 'planning' // the job brain / operator conversation. Singleton.
  | 'plan_review' // the synchronous Codex plan review. Singleton.
  | 'build' // a build slice: sequential builder legs (d1) + review agents + one review-fix.
  | 'direct_build' // the no-review fast path: a single builder, no review_agent/review_fix (d9).
  | 'master_review' // the ship-time whole-diff Codex review-&-fix. Singleton.
  | 'post_build' // the ship/amend group (d11/d14) — takes over `openPrAtShip` from Main. Singleton.
  | 'ci'; // the post-ship CI group (d14) — takes over CI handling from Main. Singleton.

/** The symbolic ORCHESTRATION SEAM a thread group of this kind spawns at (thread 3 consumes this to
 *  decide WHEN to create the thread group — no per-kind branching in the orchestrator). */
export type ThreadGroupSpawnSeam =
  | 'job_start' // planning: created the moment the job starts.
  | 'plan' // plan_review: created during planning, once a plan is authored.
  | 'dispatch' // build/direct_build: created when the locked plan is dispatched.
  | 'after_build_thread_groups' // master_review: created once every build/direct_build group completes.
  | 'after_master_review' // post_build: created once master_review (or the last build group, if none) completes.
  | 'after_ship'; // ci: created once the PR is opened/shipped.

/** One role this thread-group kind contains, with its cardinality. `max: null` = unbounded (N). */
export interface ThreadGroupRoleSpec {
  role: ThreadRole;
  /** Minimum thread count of this role the thread group requires (0 = optional, e.g. review_agent). */
  min: number;
  /** Maximum thread count, or `null` for unbounded (e.g. builder legs across rotations, d1). */
  max: number | null;
}

/** One thread-group kind's full contract. */
export interface ThreadGroupKindSpec {
  kind: ThreadGroupKind;
  /** The roles this thread group contains, with cardinality (e.g. `build` → builder(1..N) +
   *  review_agent(0..N) + review_fix(1..1); `direct_build` → builder(1..1) only, no review). */
  roles: readonly ThreadGroupRoleSpec[];
  /** Whether this thread-group kind runs a review pass at all (`false` for `direct_build`, d9). */
  hasReview: boolean;
  /** Whether `threadGroup.title` must be populated for this kind (the slice name for `build`, the round
   *  label for `planning`; other kinds derive their sidebar label from `kind` alone, d7). */
  titleRequired: boolean;
  /** The symbolic seam thread 3's orchestration spawns this thread-group kind at. */
  spawnAt: ThreadGroupSpawnSeam;
}
