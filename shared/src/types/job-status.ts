/**
 * The canonical job/thread lifecycle status — the WIRE CONTRACT between the backend and the web
 * console. Single-sourced here so the two sides can't drift: the backend re-exports it as
 * `JobStatus` (`backend/src/app/domain/thread.ts`), and the web mirrors it as `JobStatus`
 * (`web/src/lib/api/types.ts`).
 *
 * The thread IS the build unit (the former `jobs` layer is folded into it), so a "job status" and a
 * "thread status" are the same value. NOTE: the web also has a SEPARATE, web-local `JobStatus`
 * used purely for UI presentation (it adds `triaging` and folds `cancelled`→paused) — that is a
 * display concern, deliberately NOT shared. Only the backend's own value lives here.
 */
export type JobStatus =
  | 'scoping' // initial state: the planner thread is seeded, no specs written yet.
  | 'planning' // spec files are being authored.
  | 'plan_reviewing' // a plan is submitted; Codex is reviewing it (async) and/or Atlas is addressing
  // findings in dialogue — the operator hasn't been asked to approve yet. NOT a needs-you state (it's
  // Atlas/Codex's turn). The operator gate is `awaiting_approval`, reached only once the plan is proposed.
  | 'awaiting_approval' // the plan is proposed; waiting on the operator to approve.
  | 'building' // a Section (build thread group) is executing.
  | 'master_review' // the whole-diff master-review pass is running.
  | 'ready' // the post-build thread is active, awaiting the operator's ship/preview/amend call.
  | 'shipping' // "Ship it" was clicked; the ship thread is running.
  | 'pr_open' // the PR is opened; CI/mergeability is being watched.
  | 'merged' // terminal success — the PR merged.
  | 'amending' // the post-build amend loop, OR a heavy-amend re-entry into planning. A quiescent,
  // operator-steerable state: never auto-driven.
  | 'blocked' // explicitly parked waiting on one or more blocker jobs' PRs to merge (`JobDependencyService`);
  // the brain never runs while blocked. NOT a needs-you state — the system owns the next step (the
  // blocker resolving). Cleared by the wake path when every blocker reaches a terminal state.
  | 'cancelled' // off-ramp: the operator cancelled the job.
  | 'deleting'; // terminal-bound off-ramp: the operator deleted the job; container + worktree teardown is
// in progress and the row is about to be removed. Transient (self-heals via boot/reap reconcilers) and
// NOT a needs-you state — the job is going away, so it must never light the sidebar alert dot.
