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
  | 'amending' // ship review was RETRACTED (withdraw_ship / "Amend build") — the build EXISTS and is being
  // tweaked or extended, not re-planned. Reached only from `awaiting_ship_review`. A quiescent,
  // brain-controlled state: OPERATOR-owned when idle (steer Atlas), never auto-driven. Atlas amends
  // in place or dispatches a follow-up (propose_plan/start_direct_build allowed here); on completion the
  // job returns to `running` and the ship gate re-arms. NOT terminal.
  | 'blocked' // explicitly parked waiting on one or more blocker jobs' PRs to merge; the brain never runs
  // while blocked. NOT a needs-you state — the system owns the next step (the blocker resolving), like
  // plan_review. Cleared (→ 'open') by the wake path when every blocker reaches a terminal state.
  | 'done' // one PR opened, all tracks handed off
  | 'cancelled'
  | 'deleting'; // terminal-bound: the operator deleted the job; container + worktree teardown is in
// progress and the row is about to be removed. Transient (self-heals via boot/reap reconcilers) and
// NOT a needs-you state — the job is going away, so it must never light the sidebar alert dot.

/**
 * A job's HALT — the orthogonal failure/pause axis. `status` stays the pure build PHASE; when a job
 * halts (a build failure, a credential/budget block, or an incomplete build turn) this field is
 * populated and the phase is preserved, so the sidebar can render the job under the phase it halted in
 * with a red mark. `null` when the job is healthy. Mirrors the lane-level phase-preserving halt pattern
 * (`ThreadEntity.terminal_record`/`halt_outcome`) but job-scoped and leaner. Wire-shared: emitted by
 * `GET /web/jobs` and the realtime row, consumed by the web console.
 *
 * `kind` distinguishes consumer behavior: `blocked_credentials` drives request-secret / needs-you;
 * `failed`/`incomplete` are build failures; `budget_exhausted` is a rest-until-re-armed halt.
 */
export type JobHaltKind =
  | 'failed'
  | 'blocked_credentials'
  | 'budget_exhausted'
  | 'incomplete'
  | 'session_limit' // parked on a Claude session/usage limit; auto-resumes at resumeAt
  | 'codex_review_unavailable'; // parked on a master_review Codex outage (network/auth-to-Codex); auto-resumes on the resume clock, or the operator can 'ship without review'.
export type JobHalt = {
  kind: JobHaltKind;
  /** Short human string (what `relayFailure` already computes via `shortReason`). */
  reason: string;
  /** ISO timestamp the halt was recorded. */
  at: string;
  /** ISO reset timestamp; when set, the lane auto-resumes once it passes (session_limit halts). */
  resumeAt?: string;
};

/**
 * The orthogonal "system is working" axis on a job — what the AI/pipeline is DOING right now, separate
 * from the build PHASE (`JobStatus`) and the failure gate (`JobHalt`). Any non-`idle` value means the
 * system owns the next step, so the sidebar suppresses the "needs you" dot (see `deriveNeedsYou`). It is
 * ephemeral: reset to `idle` on boot (no in-flight work survives a process restart). The DB column stays
 * `text` (the repo's status-column convention), with the union enforced in TS at every boundary.
 *
 *  - `turn`          — a live conversational (brain) turn is streaming.
 *  - `plan_review`   — a synchronous Codex plan review is in flight (outranks a `turn` it nests inside).
 *  - `build`         — the driver is executing a builder thread.
 *  - `master_review` — the driver is running the whole-diff master review.
 *  - `base_check`    — post-approval, pre-build: rebasing/checking the base branch before starting.
 */
export const JOB_ACTIVITIES = ['idle', 'turn', 'plan_review', 'build', 'master_review', 'base_check', 'retrying'] as const;
export type JobActivity = (typeof JOB_ACTIVITIES)[number];

/**
 * Why a thread parked on its `blocked` terminal record — the WIRE CONTRACT for the `blockReason` field the
 * pipeline read-model emits (single-sourced here so the backend and web console can't drift). `judge_unavailable`
 * is the transient verification-judge outage the operator "Retry now"/"Skip & accept" controls recover.
 */
export type ThreadBlockReason =
  | 'question'
  | 'needs_env'
  | 'decision'
  | 'unverified'
  | 'judge_unavailable';
