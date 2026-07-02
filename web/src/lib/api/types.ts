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

export type WireJobKind = 'feature' | 'bugfix';

/** The lane (Thread) status — one build lane within a Job. */
export type ThreadStatus =
  | 'pending'
  | 'planning'
  | 'reviewing'
  | 'awaiting_approval'
  | 'executing'
  | 'auto_fixing'
  | 'done'
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
  name: string;
  path: string;
  description: string;
  /** A headless-login URL (e.g. `gcloud auth login --no-browser`) to render as a clickable link above the field. */
  url?: string;
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

/** One post-build review agent over a thread's diff: id + human label + its per-agent status. `pending`
 *  before the thread is reviewed, transitioned by the auto-fix stage, `skipped` when the diff was empty. */
export interface ReviewAgent {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  /** Findings the agent surfaced (set once it has run). */
  findings?: number;
}

/**
 * One task in an orchestrating session's LIVE, LLM-authored checklist — folded server-side from its
 * `TaskCreate`/`TaskUpdate` tool calls (no fixed/expected set, unlike {@link ReviewAgent}: `[]` just means
 * the session hasn't created any tasks yet, not "not started"). `dropped` is the SDK's `deleted` status.
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
  /** The thread's scope type (backend/frontend/docs/…) — selects the review agents. */
  type: string;
  status: ThreadStatus;
  /**
   * The review agents selected to run over this thread's diff (a fixed set today; backend-selected).
   * The navigator's review folder renders one leaf per agent — never hard-code this list.
   */
  reviewAgents: ReviewAgent[];
  /** The thread's own live task list — see {@link TaskItem}. `[]` until its session creates a task. */
  tasks: TaskItem[];
  /** Whether a just-in-time plan was generated — gates the optional `plan` leaf in the nav tree. */
  hasPlan: boolean;
  /** The thread's steps (execute folder leaves), ordinal-sorted. */
  steps: PipelineStep[];
}

/**
 * The job's Codex plan-review dialogue, summarized for the navigator's "Codex review" row. Null when the
 * plan was never submitted for review. The full round-by-round transcript streams on `lane`.
 */
export interface CodexReviewSummary {
  /** The transcript lane the full review stream rides (`codex-review:<jobId>`). */
  lane: string;
  /** How many rounds (submit_plan re-reviews + respond_to_review replies) have run. */
  rounds: number;
  latestRound: number;
  /** The latest round's state. */
  status: 'running' | 'complete' | 'failed';
  /** Findings in the latest round (0 = clean / a concede). */
  findingsCount: number;
}

export interface PipelineJob {
  /** The thread id — the backend keys the pipeline on the thread (thread = the build unit). */
  jobId: string;
  title: string;
  kind: WireJobKind;
  status: WireJobStatus;
  decisionRecordId: string | null;
  /** The Codex plan-review dialogue summary (a lane under Main), or null if never reviewed. */
  codexReview?: CodexReviewSummary | null;
  /** The PR-tail review agents over the whole feature diff (the job-level "Final review" pass). `[]` until
   *  that pass runs — unlike the per-thread fallback there's no pre-seed default. */
  reviewAgents: ReviewAgent[];
  /**
   * The PR Review orchestrator's live task list ("Master code review" → "Apply fixes" → "Verify build"),
   * folded from its own `TaskCreate`/`TaskUpdate` calls. `[]` until `prReviewStatus` moves past `queued`.
   */
  tasks: TaskItem[];
  /**
   * The PR Review card's coarse status. Null until the orchestrator starts. `running` covers the whole
   * session — derive the finer "reviewing"/"fixing"/"verifying" sub-label from whichever task in `tasks`
   * is currently `in_progress`.
   */
  prReviewStatus: 'queued' | 'running' | 'opened' | 'failed' | null;
  /**
   * The MAIN brain session's own task list (folded from its `main`-lane task-tool calls) — the
   * navigator's Main row renders it. A separate list from `tasks` (PR Review's), same TaskItem shape.
   */
  mainTasks: TaskItem[];
  /** The opened PR (ARTIFACTS), or null until the PR-tail stage opens one. */
  prUrl: string | null;
  prNumber: number | null;
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
 * `ServiceInfo` — a DURABLE snapshot, not a live liveness check (the host can't see into the container's
 * PID namespace), so a service may show its last marker after it has actually stopped.
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

/** UI kind badge — `feat`/`fix` from WireJobKind; `event` denotes a notification-seeded job. */
export type JobKind = 'feat' | 'fix' | 'event';
