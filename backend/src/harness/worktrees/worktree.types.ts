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
  /** The project the work belongs to ('' when adopted). */
  project: string;
}

export interface NewWorktree {
  name: string;
  /** Check out this existing branch instead of cutting a fresh `agent/<owner>/…` one from HEAD. */
  branch?: string;
  ownerBot: string;
  project: string;
}
