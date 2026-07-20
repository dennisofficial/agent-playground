export enum EOrgStatus {
  ONBOARDING = 'onboarding',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

export enum EOrgRole {
  OWNER = 'owner',
  MEMBER = 'member',
}

export enum EUserRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
}

/**
 * How a workspace mount is exposed to a job's sandbox — the WIRE CONTRACT (single-sourced so the DB `enum`
 * column and the web console can't drift).
 * - `PER_THREAD` — a fresh copy per thread/worktree (isolated, writable).
 * - `SHARED_RO`  — one shared mount across threads, read-only (e.g. a model/cache dir).
 * - `SHARED_RW`  — one shared mount across threads, read-write (e.g. a package store).
 */
export enum EMountMode {
  PER_THREAD = 'per-thread',
  SHARED_RO = 'shared-ro',
  SHARED_RW = 'shared-rw',
}

export enum EUserStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

// NOTE: the org's raw API keys (Anthropic / OpenAI / GitHub PAT) are typed columns on the
// `org_credentials` table, not an enum-keyed vault. Subscription OAuth (Claude/Codex) is multi-account
// and lives in the agent-credentials module (`agent_credentials`).

/**
 * An agent SDK a subscription account can log into. Distinct from the org's raw API keys: these are
 * OAuth subscription logins (Claude.ai / ChatGPT), multi-account per org, refreshed over time.
 */
export enum EAgentProvider {
  /** Anthropic Claude subscription (Claude Code OAuth / setup-token). */
  CLAUDE = 'claude',
  /** OpenAI Codex / ChatGPT subscription (device-code OAuth / pasted auth.json). */
  CODEX = 'codex',
}

/**
 * How an agent credential was obtained. `personal` is a full OAuth login we can refresh; `setup_token`
 * is a pasted long-lived secret (Claude `sk-ant-oat…` token or a Codex `~/.codex/auth.json` blob).
 */
export enum EAgentCredentialKind {
  PERSONAL = 'personal',
  SETUP_TOKEN = 'setup_token',
}

export enum EAgentCredentialStatus {
  ACTIVE = 'active',
  NEEDS_REAUTH = 'needs_reauth',
  ERROR = 'error',
}

// The canonical categorical enums for the job aggregate. Single-sourced here so the backend (DB `enum`
// columns + read views) and the web console can't drift. A **job** is the top build unit; it owns thread
// groups → threads → thread messages (+ subagents), and a group owns tasks.

/**
 * The canonical job lifecycle status — the WIRE CONTRACT. NOTE: the web also has a SEPARATE, web-local
 * presentation status (adds `triaging`, folds `cancelled`→paused) that is deliberately NOT shared.
 */
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

/**
 * The orthogonal "system is working" axis on a job — what the AI/pipeline is DOING right now, separate
 * from the build PHASE ({@link EJobStatus}). Any non-`idle` value means the system owns the next step.
 */
export enum EJobActivity {
  IDLE = 'idle',
  TURN = 'turn', // a live conversational (brain) turn is streaming
  PLAN_REVIEW = 'plan_review', // a synchronous Codex plan review is in flight
  BUILD = 'build', // the driver is executing a builder thread
  MASTER_REVIEW = 'master_review', // the driver is running the whole-diff master review
  BASE_CHECK = 'base_check', // post-approval, pre-build: rebasing/checking the base branch
  RETRYING = 'retrying',
}

export enum EJobKind {
  FEATURE = 'feature',
  BUGFIX = 'bugfix',
  ONBOARDING = 'onboarding', // the repo's first-run workspace setup
  EVENT = 'event', // an automated (CI/review) follow-up
  REVIEW = 'review', // a standalone review pass
}

export enum EThreadOrigin {
  CHAT = 'chat',
  EVENT = 'event',
  CONTROL = 'control',
}

export enum EThreadStatus {
  PENDING = 'pending',
  PLANNING = 'planning',
  REVIEWING = 'reviewing',
  EXECUTING = 'executing',
  AUTO_FIXING = 'auto_fixing',
  DONE = 'done',
}

export enum EThreadCondition {
  NONE = 'none',
  PAUSED = 'paused', // a mid-build pause (request_operator_input / thread-level approval)
  INCOMPLETE = 'incomplete', // halted without asserting completion
  FAILED = 'failed', // crashed / errored out
  SKIPPED = 'skipped', // a review child that had nothing to do — terminal, not a failure
}

export enum EStepStatus {
  PENDING = 'pending',
  BUILDING = 'building',
  REVIEWING = 'reviewing',
  DONE = 'done',
}

export enum EThreadRole {
  PLANNING = 'planning',
  PLAN_REVIEW = 'plan_review',
  BUILDER = 'builder',
  REVIEW_AGENT = 'review_agent',
  REVIEW_FIX = 'review_fix',
  MASTER_REVIEW = 'master_review',
  POST_BUILD = 'post_build',
  CI = 'ci',
}

export enum EThreadType {
  BACKEND = 'backend',
  FRONTEND = 'frontend',
  DOCS = 'docs',
  TESTING = 'testing',
  INFRA = 'infra',
  DATA = 'data',
  GENERAL = 'general',
}

export enum EThreadGroupKind {
  PLANNING = 'planning',
  PLAN_REVIEW = 'plan_review',
  BUILD = 'build',
  DIRECT_BUILD = 'direct_build',
  MASTER_REVIEW = 'master_review',
  POST_BUILD = 'post_build',
  CI = 'ci',
}

export enum EThreadMessageKind {
  CHAT = 'chat',
  THINKING = 'thinking',
  TOOL = 'tool',
  CARD = 'card',
  BUILD_EVENT = 'build_event',
}

export enum EThreadMessageSource {
  OPERATOR = 'operator',
  ATLAS = 'atlas',
  SYSTEM_OPERATOR = 'system_operator', // system → operator only (Atlas never sees it)
  SYSTEM_SHARED = 'system_shared', // system → operator AND Atlas (e.g. Codex plan-review findings)
  SYSTEM_EVENT = 'system_event', // an automated notification that opened the thread
  SYSTEM_NOTICE = 'system_notice',
  SYSTEM_REMINDER = 'system_reminder',
  UNTRUSTED = 'untrusted', // content from an untrusted external source
}

export enum ETaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  DROPPED = 'dropped',
}

export enum ESubagentStatus {
  RUNNING = 'running',
  DONE = 'done',
  FAILED = 'failed',
}
