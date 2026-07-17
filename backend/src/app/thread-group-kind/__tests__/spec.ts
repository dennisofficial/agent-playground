import type { ThreadRole } from '../../thread-kind/__tests__/spec';

export type ThreadGroupKind =
  | 'planning' // the job brain / operator conversation. Singleton.
  | 'plan_review' // the synchronous Codex plan review. Singleton.
  | 'build' // a build slice: sequential builder legs (d1) + review agents + one review-fix.
  | 'direct_build' // the no-review fast path: a single builder, no review_agent/review_fix (d9).
  | 'master_review' // the ship-time whole-diff Codex review-&-fix. Singleton.
  | 'post_build' // the ship/amend group (d11/d14) — takes over `openPrAtShip` from Main. Singleton.
  | 'ci'; // the post-ship CI group (d14) — takes over CI handling from Main. Singleton.

export type ThreadGroupSpawnSeam =
  | 'job_start' // planning: created the moment the job starts.
  | 'plan' // plan_review: created during planning, once a plan is authored.
  | 'dispatch' // build/direct_build: created when the locked plan is dispatched.
  | 'after_build_thread_groups' // master_review: created once every build/direct_build group completes.
  | 'after_master_review' // post_build: created once master_review (or the last build group, if none) completes.
  | 'after_ship'; // ci: created once the PR is opened/shipped.

export interface ThreadGroupRoleSpec {
  role: ThreadRole;
  min: number;
  max: number | null;
}

export interface ThreadGroupKindSpec {
  kind: ThreadGroupKind;
  roles: readonly ThreadGroupRoleSpec[];
  hasReview: boolean;
  titleRequired: boolean;
  spawnAt: ThreadGroupSpawnSeam;
}
