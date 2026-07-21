export enum EJobStatus {
  OPEN = 'open', // a conversation; no build scoped yet
  PLANNING = 'planning', // upfront grill in progress (no locked plan yet)
  PLAN_REVIEW = 'plan_review', // plan submitted; Codex reviewing (async) / Atlas addressing findings — not a needs-you state
  AWAITING_APPROVAL = 'awaiting_approval', // decision record + track list posted; waiting on the operator
  RUNNING = 'running', // tracks executing
  AWAITING_SHIP_REVIEW = 'awaiting_ship_review', // reviewed diff parked on the operator's "Ship it" — the SECOND human gate
  AMENDING = 'amending', // ship review RETRACTED (withdraw_ship) — the build exists and is being tweaked, not re-planned
  BLOCKED = 'blocked', // parked waiting on blocker jobs' PRs to merge; the brain never runs while blocked
  DONE = 'done', // one PR opened, all tracks handed off
  CANCELLED = 'cancelled',
  DELETING = 'deleting', // operator deleted the job; container + worktree teardown in progress (transient)
  ARCHIVED = 'archived', // TERMINAL: archived (manual or idle sweep); row + transcript survive, mutations 409
}

export enum EJobKind {
  FEATURE = 'feature',
  BUGFIX = 'bugfix',
  ONBOARDING = 'onboarding', // the repo's first-run workspace setup
  EVENT = 'event', // an automated (CI/review) follow-up
  REVIEW = 'review', // a standalone review pass
}
