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
  | 'open' // a conversation; no build scoped yet
  | 'planning' // upfront grill in progress (no locked plan yet)
  | 'plan_review' // plan submitted; Codex is reviewing it (async) and/or Atlas is addressing findings —
  // the operator hasn't been asked to approve yet. NOT a needs-you state (it's Atlas/Codex's turn). The
  // operator gate is `awaiting_approval`, reached only when Atlas calls `finalize_plan`.
  | 'awaiting_approval' // decision record + track list posted; waiting on the operator
  | 'running' // tracks executing
  | 'awaiting_ship_review' // all builders + master review finished; the reviewed diff is parked waiting on
  // the operator to eyeball it and click "Ship it" before the PR is opened. The SECOND human gate (after
  // `awaiting_approval` at the plan stage) — a needs-you state. Only driver builds (feature/bugfix) reach
  // it; the direct-build fast path and `review` jobs never do. Approval flips back to `running` + re-drives.
  | 'paused' // a turn hit a credential/401 error; the live session is saved, waiting on a re-ping to
  // resume (NOT auto-resumed on boot — it would just 401 again). Durable: the unfinished step keeps its
  // `session_id`, so a ping continues the SAME session instead of starting from scratch.
  | 'done' // one PR opened, all tracks handed off
  | 'failed'
  | 'cancelled'
  | 'deleting'; // terminal-bound: the operator deleted the job; container + worktree teardown is in
// progress and the row is about to be removed. Transient (self-heals via boot/reap reconcilers) and
// NOT a needs-you state — the job is going away, so it must never light the sidebar alert dot.
