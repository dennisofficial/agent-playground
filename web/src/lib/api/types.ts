/**
 * Contracts for the Atlas web surface (`/web/*`). These MIRROR the backend shapes verbatim:
 *  - `WebApprovalCard` / `WebVerdictCard` — the approval-card payload carried on a message's `card`.
 *  - `PipelineState` — `DriverStoreService.getPipelineState` (job + threads + per-thread steps; carries
 *    the thread's PR url/number + feature/base branch — the navigator's ARTIFACTS + header read them).
 *
 * The live message + request shapes are owned by `job-api.ts` (the org → repo → thread client).
 */

import type { JobStatus as WireJobStatus } from '@workspace/shared';

// ── Backend (wire) enums ─────────────────────────────────────────────────────────────────────────
/**
 * The backend job WIRE status — single-sourced in `@workspace/shared` so it can't drift from the
 * backend's `JobStatus`. (The web's own UI-presentation `JobStatus` — below — is a separate type.)
 */
export type { WireJobStatus };

export type WireJobKind = 'feature' | 'bugfix' | 'onboarding' | 'event';

/** The lane (Thread) status — one build lane within a Job. */
export type ThreadStatus =
  | 'pending'
  | 'planning'
  | 'reviewing'
  | 'awaiting_approval'
  | 'executing'
  | 'awaiting_input'
  | 'auto_fixing'
  | 'skipped' // a review child that had nothing to do (unknown lens / no diff) — terminal, not a failure
  | 'done'
  | 'incomplete'
  | 'failed';

/** Per-step status (the execute folder's leaves). Mirrors backend `StepStatus` in `domain/thread.ts`. */
export type StepStatus =
  | 'pending'
  | 'building'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'skipped';

// ── Approval / verdict cards ───────────────────────────────────────────────────────────────────
export const APPROVE_ACTION_ID = 'atlas_approval:approve';
export const REQUEST_CHANGES_ACTION_ID = 'atlas_approval:request_changes';
export const DENY_ACTION_ID = 'atlas_approval:deny';
export const VIEW_PLAN_ACTION_ID = 'atlas_approval:view_plan';

export type ApprovalActionId =
  | typeof APPROVE_ACTION_ID
  | typeof REQUEST_CHANGES_ACTION_ID
  | typeof DENY_ACTION_ID;

export interface ApprovalDecision {
  decisionClass: string;
  title: string;
  ruling: string;
  /** PROVENANCE — true when the operator confirmed this call; false/absent = Atlas authored the default. */
  confirmedByOperator?: boolean;
}

export interface WebCardAction {
  actionId: string;
  label: string;
  style: 'primary' | 'danger' | 'default';
  /** Link buttons (e.g. "View full plan") carry a URL; otherwise the click POSTs a verdict. */
  url?: string;
  /** Serialized `ApprovalActionMeta` (jobId + decisionRecordId) — sent back verbatim on /web/approve. */
  value: string;
}

export interface WebApprovalCard {
  type: 'approval_card';
  jobId: string;
  decisionRecordId?: string;
  /** `plan` (full ceremony) or `direct` (fast path) — labels the list "Sections" vs "Changes". */
  kind?: 'plan' | 'direct';
  title: string;
  summary: string;
  decisions: ApprovalDecision[];
  threads: string[];
  planUrl?: string;
  actions: WebCardAction[];
}

export interface WebVerdictCard {
  type: 'verdict_card';
  jobId: string;
  title: string;
  verdict: string;
  verdictLine: string;
}

/** One selectable answer in a question card (mirrors the backend `WebQuestionOption`). */
export interface WebQuestionOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * A formal question the brain posed via `ask_question` — rendered as a card with one button per option
 * (+ optional free-text "Other"). The operator's pick POSTs to `…/threads/:jobId/answer-question`.
 * When `answer` is set the card renders the compact answered state. Mirrors the backend `WebQuestionCard`.
 */
export interface WebQuestionCard {
  type: 'question_card';
  jobId: string;
  questionId: string;
  header?: string;
  question: string;
  decisionClass?: string;
  options: WebQuestionOption[];
  allowOther: boolean;
  answer?: string;
  answeredAt?: string;
  loggedDecision?: boolean;
  /** Set when the brain RETRACTED this still-unanswered question (`withdraw_question`) — renders a compact
   *  "withdrawn" state with no answer buttons. Terminal, like `answer`. */
  withdrawnAt?: string;
  withdrawnReason?: string;
}

/**
 * A secure SECRET request the onboarding brain posed via `request_secret` — rendered as a masked input.
 * The operator's value POSTs to `…/threads/:jobId/provide-secret`, which stores it ENCRYPTED + grants
 * it; the value is NEVER part of this card. When `provided_at` is set the card renders a compact "provided"
 * state. Mirrors the backend `WebSecretInputCard` (deliberately value-free).
 */
export interface WebSecretInputCard {
  type: 'secret_input_card';
  jobId: string;
  requestId: string;
  /** Secret name, or a display LABEL only when {@link ephemeral}. */
  name: string;
  /** Durable destination; absent for an ephemeral request. */
  path?: string;
  description: string;
  /** A headless-login URL (e.g. `gcloud auth login --no-launch-browser`) to render as a clickable link above the field. */
  url?: string;
  /** One-time value delivered straight to the running sandbox and NEVER stored (OAuth code, 2FA, sudo pw). */
  ephemeral?: boolean;
  /** Ephemeral-only: the in-container path the value is piped to (operational, not a secret). */
  deliver_to?: string;
  provided_at?: string;
  delivered_at?: string;
}

/**
 * A secure FILE request the onboarding brain posed via `request_file` — rendered as a file picker. The
 * operator's file is read as text and POSTs to `…/threads/:jobId/provide-file`, which stores the contents
 * ENCRYPTED + grants them; the contents are NEVER part of this card. When `provided_at` is set the card
 * renders a compact "uploaded" state. Mirrors the backend `WebFileRequestCard` (deliberately value-free).
 */
export interface WebFileRequestCard {
  type: 'file_request_card';
  jobId: string;
  requestId: string;
  path: string;
  description: string;
  filename?: string;
  provided_at?: string;
  delivered_at?: string;
}

/** One quoted selection + note in a sent review-comment bundle. `file` is the display label (e.g. the
 *  file's basename) the operator had open when they commented, not the full context-bucket path. */
export interface WebReviewCommentItem {
  file: string;
  quote: string;
  note?: string;
}

/**
 * A batch of inline review comments the operator sent via the highlight-and-comment flow ("Atlas Workspace
 * HiFi") — the operator selected text in the detail pane, noted it, and sent the queue as one message.
 * Rendered as a distinct right-aligned card (grouped by file); an optional trailing `message` is the
 * operator's typed prose, rendered as a normal bubble underneath. Mirrors the backend `review_comments_card`.
 */
export interface WebReviewCommentsCard {
  type: 'review_comments_card';
  items: WebReviewCommentItem[];
  message?: string;
}

export type WebCard =
  | WebApprovalCard
  | WebVerdictCard
  | WebQuestionCard
  | WebSecretInputCard
  | WebFileRequestCard
  | WebReviewCommentsCard;

// ── Pipeline (`…/threads/:jobId/pipeline`) ────────────────────────────────────────────────────
/** One step of a thread's locked plan — the execute folder's leaf (a Claude Code session). */
export interface PipelineStep {
  id: string;
  ordinal: number;
  title: string | null;
  brief: string;
  /** The resumable cursor within the step ('build' | 'review' | 'fix'). */
  stage: string;
  status: StepStatus;
  /** The execution batch this step belongs to within its thread; null until the thread first executes. */
  batchOrdinal: number | null;
  /**
   * The ANCHOR step id of this step's batch — a batch runs as ONE engine turn whose transcript is tagged
   * with the anchor's id. A non-anchor step must remap to this before reading the transcript / live lane.
   * Defaults to the step's own id when not yet batched.
   */
  anchorStepId: string;
  /** Every step id in this step's batch (so the sub-page can show "steps 2–4 built together"). */
  batchStepIds: string[];
}

/**
 * One review CHILD thread of a builder — a `review_lens` (one self-review pass) or the single `post_review`
 * (fix · apply · verify). A first-class thread row: its own status + streaming `lane` + (for a lens) the
 * `lensId` and finding count. The navigator renders these directly as bare child-thread nodes (no synthetic
 * `rev:`/`fix:` ids); `lane` is the `autofix:<parentId>:<lensId>` / `autofix:<parentId>:fix` transcript lane.
 */
export interface PipelineReviewChild {
  id: string;
  kind: 'review_lens' | 'post_review';
  brief: string;
  status: ThreadStatus;
  /** The lens id (`best_practices`/…) for a `review_lens` child; absent for `post_review`. */
  lensId?: string;
  /** Findings this lens surfaced, or null until it has run (`post_review` is always null). */
  findings: number | null;
  /** The transcript lane the child streams on (the SAME lane the backend turn writes). */
  lane: string;
}

/**
 * One task in an orchestrating session's LIVE, LLM-authored checklist — folded server-side from its
 * `TaskCreate`/`TaskUpdate` tool calls (no fixed/expected set: `[]` just means the session hasn't created
 * any tasks yet, not "not started"). `dropped` is the SDK's `deleted` status.
 */
export interface TaskItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'dropped';
  /** The SDK task's longer description — shown under an in_progress task + as the row tooltip. */
  description?: string;
  /** Present-continuous label ("Resolving the router chain") shown while in_progress; falls back to subject. */
  activeForm?: string;
  /** Dependency edges — ids of tasks this one waits on. A PENDING task with an incomplete blocker renders
   *  BLOCKED (derived; the block clears when every blocker completes or is deleted). */
  blockedBy?: string[];
}

export interface PipelineThread {
  id: string;
  ordinal: number;
  brief: string;
  /** The thread's scope type (backend/frontend/docs/…). */
  type: string;
  status: ThreadStatus;
  /** The thread KIND (`builder` | `master_review`) — the single differentiator. */
  kind?: string;
  /** True for the whole-diff Codex master-review thread (derived from `kind`) — rendered "Master review"
   *  with no review children. */
  isMasterReview?: boolean;
  /**
   * This builder's review CHILD threads (review_lens × N + post_review) — each a first-class row the
   * navigator renders directly. `[]` until the builder finishes executing and its review is materialized;
   * always `[]` for a master-review thread (it IS the review).
   */
  children: PipelineReviewChild[];
  /** The thread's own live task list — see {@link TaskItem}. `[]` until its session creates a task. */
  tasks: TaskItem[];
  /** Whether a just-in-time plan was generated — gates the optional `plan` leaf in the nav tree. */
  hasPlan: boolean;
  /** The thread's steps (execute folder leaves), ordinal-sorted. */
  steps: PipelineStep[];
}

export interface PipelineJob {
  /** The thread id — the backend keys the pipeline on the thread (thread = the build unit). */
  jobId: string;
  title: string;
  kind: WireJobKind;
  status: WireJobStatus;
  decisionRecordId: string | null;
  /**
   * The MAIN brain session's own task list (folded from its `main`-lane task-tool calls) — the
   * navigator's Main row renders it. (The old job-level PR-review `reviewAgents`/`tasks`/`prReviewStatus`
   * are gone — master review is now a normal build thread with its own per-thread fields.)
   */
  mainTasks: TaskItem[];
  /** The plan-review (Codex) thread — a first-class navigator row that opens the `codex-review:<jobId>`
   *  lane (the review dialogue Main communicates with). Null when no review has run. */
  planReview: { status: string } | null;
  /** The opened PR (ARTIFACTS), or null until the PR-tail stage opens one. */
  prUrl: string | null;
  prNumber: number | null;
  /** Observed PR lifecycle (`jobs.pr_state`) — same source as the sidebar glyph; null until a PR exists. */
  prState: PrState | null;
  /** GitHub `mergeable_state` (`'dirty'` = merge conflict), or null. Refines the `open` state's coloring. */
  prMergeable: string | null;
  /** The feature branch all threads stack on (header), or null before the sandbox is cut. */
  featureBranch: string | null;
  baseBranch: string | null;
  threads: PipelineThread[];
}

/**
 * `no_job` = the job never entered the build lifecycle (still `open`, chatting/planning). It still
 * carries the brain's own `mainTasks` so the navigator's Main row can show the checklist pre-plan.
 */
export type PipelineState = PipelineJob | { status: 'no_job'; mainTasks?: TaskItem[] };

/** The Main brain session's task list, from either pipeline shape (`no_job` carries it too). */
export function pipelineMainTasks(pipeline: PipelineState | undefined): TaskItem[] {
  if (!pipeline) return [];
  return ('mainTasks' in pipeline ? pipeline.mainTasks : undefined) ?? [];
}

// ── Context files (`…/threads/:jobId/context`) ────────────────────────────────────────────────
/** One file in a `/context` bucket — mirrors the backend `ContextFile`. */
export interface ContextFile {
  name: string;
  size: number;
  /** ISO timestamp of last modification. */
  mtime: string;
}

/**
 * The thread's `/context` listing: `specs` (the plan — plan.md, decision-record.md, diagrams) and
 * `artifacts` (outputs — preview HTML, screenshots). A bucket is `[]` before the agent writes anything.
 */
export interface JobContext {
  specs: ContextFile[];
  /** System-GENERATED, read-only files (e.g. decision-record.md) — written by tool calls, never by hand. */
  generated: ContextFile[];
  artifacts: ContextFile[];
}

/** One `/context` file's content for the viewer (`…/context/file?path=…`). Mirrors the backend shape. */
export interface ContextFileContent {
  name: string;
  /** Path relative to the `/context` root, forward-slashed (e.g. `specs/plan.md`). */
  path: string;
  size: number;
  mtime: string;
  /** `text` → utf-8 in `content`; `base64` → binary (images) in `content`. */
  encoding: 'text' | 'base64';
  /** Best-effort mime by extension (e.g. `text/markdown`, `image/png`). */
  mime: string;
  content: string;
}

// ── Supervised services (`…/threads/:jobId/services`) ────────────────────────────────────────────
/**
 * One process the agent started via `atlas-svc run`, from its durable marker file. Mirrors the backend
 * `ServiceInfo`. The marker fields (pid/startedAt/log*) are a durable snapshot; `status` is a LIVE
 * liveness check the backend runs by execing a generation-gated `kill -0` probe into the container.
 */
export interface ServiceInfo {
  id: string;
  name: string;
  cmd: string;
  pid: number | null;
  pgid: number | null;
  startedAt: string | null;
  logBytes: number;
  logUpdatedAt: string | null;
  /**
   * Live liveness: `running` (process answered in the current container generation), `stopped` (marker
   * present but the process is gone — crash, `atlas-svc stop`, or a previous/absent container),
   * `unknown` (couldn't probe: no running container, null pgid/startedAt, or a transient exec failure).
   */
  status: 'running' | 'stopped' | 'unknown';
}


// ── UI job model ───────────────────────────────────────────────────────────────────────────────
/** The Job UI-presentation status set from handoff §7 (semantic dot colors). */
export type JobStatus =
  | 'running'
  | 'planning'
  | 'plan_review'
  | 'awaiting_approval'
  | 'done'
  | 'triaging'
  | 'paused'
  | 'failed'
  | 'deleting';

/** UI kind badge — `feat`/`fix` from WireJobKind; `event` denotes a notification-seeded job;
 *  `onboard` is the Atlas-run repo-init (onboarding) job. */
export type JobKind = 'feat' | 'fix' | 'event' | 'onboard';

/** Observed PR lifecycle — the backend `jobs.pr_state`. Null (no `pr`) means no PR yet. */
export type PrState = 'open' | 'merged' | 'closed';

/** The observed PR on a job — drives the sidebar's PR-status glyph (see `PrStatusIcon`). `mergeable` is
 *  GitHub's `mergeable_state` ('dirty' = merge conflict); `url` links to the PR. */
export interface InboxPr {
  state: PrState;
  mergeable: string | null;
  url: string | null;
}
