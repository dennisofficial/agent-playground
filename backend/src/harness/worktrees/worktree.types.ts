/**
 * A worktree is an employee-managed isolated work area: a full-repo git checkout cut off the repo
 * that WORKER_ROOT lives in. It is NOT a write grant — sessions decide read-only vs write per turn
 * (engine mode); the worktree just guarantees whatever they do can't touch the trunk or each other's
 * trees. One worktree can host several sessions (e.g. a parallel review).
 */
export interface Worktree {
  /** Registry id (`wt-NNN`) — what the worktree tools take. */
  id: string;
  /** The employee-supplied short name (slugified into the directory/branch). */
  name: string;
  /** The branch checked out in this worktree. */
  branch: string;
  /** The commit the branch was cut from ('' for a worktree re-adopted after a restart). */
  baseRef: string;
  /** The session working directory (checkout root + the repo-subdir WORKER_ROOT sits at). Engine cwd. */
  path: string;
  /** The checkout root — what `git worktree remove` targets. */
  checkout: string;
  /** The employee that created it ('' when adopted and the branch doesn't carry an owner). */
  ownerBot: string;
  /** The tenant (Slack team id) the work belongs to (DEFAULT_TEAM for WORKER_ROOT / dev). */
  team: string;
  /** The project the work belongs to ('' when adopted from WORKER_ROOT). */
  project: string;
  /** The repo this checkout belongs to (WORKER_ROOT's repo, or a registered project's clone).
   * Remote ops verify this repo IS the project's registered repo before touching the network. */
  repoRoot: string;
  /** The shared integration branch this worktree publishes to / pulls from (multi-employee feature
   * work). Recorded durably in git branch config, so it survives restarts and re-attaches. */
  sharedBranch?: string;
}

export interface NewWorktree {
  name: string;
  /** Check out this existing branch instead of cutting a fresh `agent/<owner>/…` one from HEAD. */
  branch?: string;
  /** Join (or start) a shared integration branch for the feature; slugified into `shared/<slug>`.
   * The personal branch is cut FROM it, so everyone on the feature starts from the same base. */
  shared?: string;
  ownerBot: string;
  team: string;
  project: string;
}

/** The outcome of a publish/pull against a worktree's shared integration branch. */
export interface IntegrationResult {
  integrated: boolean;
  sharedBranch: string;
  /** Conflicted paths when integrated=false — the merge is left IN PROGRESS in the checkout so a
   * session's next turn can resolve and commit it. */
  files?: string[];
  /** Publish only: the checkout had uncommitted changes — those were NOT published (only commits
   * publish). */
  dirty?: boolean;
  /** Publish only, always present when the local publish integrated: the origin sync outcome.
   * `pushed: false` + detail reports a partial result (no registered repo, identity-guard refusal,
   * or push failure) WITHOUT touching `integrated` — the local publish is never lost to a remote
   * failure, but a shared branch that didn't reach GitHub always says so. */
  remote?: { pushed: boolean; detail?: string };
  /** Pull only: whether the shared ref was first fast-forwarded from origin (false = local-only
   * merge: no registered repo, or the fetch didn't land). */
  originFetched?: boolean;
}

/** The outcome of refreshing a worktree's branch against its project's base branch (merge of
 * `origin/<defaultBranch>`). Distinct from IntegrationResult: base refresh applies to UNSHARED
 * worktrees and reports the base branch, not a shared integration branch. */
export interface BaseRefreshResult {
  /** True = merged origin's base in, or already current. False = no-op (unregistered project,
   * origin-guard refusal, or the fetch didn't land) or a conflict. */
  refreshed: boolean;
  /** The project's base branch (`<defaultBranch>`), when a registered record was found. */
  baseBranch?: string;
  /** The merge hit conflicts and is left IN PROGRESS in the checkout for a session to resolve. */
  conflicted?: boolean;
  /** Conflicted paths when `conflicted`. */
  files?: string[];
  /** Why this was a no-op: unregistered project, origin-guard refusal, or fetch failure. */
  detail?: string;
}
