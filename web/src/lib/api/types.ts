/**
 * Contracts for the Atlas web surface (`/web/*`). These MIRROR the backend shapes verbatim:
 *  - `WebApprovalCard` / `WebVerdictCard` — the approval-card payload carried on a message's `card`.
 *  - `PipelineState` — `DriverStoreService.getPipelineState` (job + tracks + per-track steps; carries
 *    the thread's PR url/number + feature/base branch — the navigator's ARTIFACTS + header read them).
 *
 * The live message + request shapes are owned by `thread-api.ts` (the org → repo → thread client).
 */

// ── Backend enums ──────────────────────────────────────────────────────────────────────────────
export type JobStatus =
  | 'scoping'
  | 'plan_review'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export type JobKind = 'feature' | 'bugfix';

export type TrackStatus =
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
  tracks: string[];
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
 * (+ optional free-text "Other"). The operator's pick POSTs to `…/threads/:threadId/answer-question`.
 * When `answer` is set the card renders the compact answered state. Mirrors the backend `WebQuestionCard`.
 */
export interface WebQuestionCard {
  type: 'question_card';
  threadId: string;
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

export type WebCard = WebApprovalCard | WebVerdictCard | WebQuestionCard;

// ── Pipeline (`…/threads/:threadId/pipeline`) ────────────────────────────────────────────────────
/** One step of a track's locked plan — the execute folder's leaf (a Claude Code session). */
export interface PipelineStep {
  id: string;
  ordinal: number;
  title: string | null;
  brief: string;
  /** The resumable cursor within the step ('build' | 'review' | 'fix'). */
  stage: string;
  status: StepStatus;
}

export interface PipelineTrack {
  id: string;
  ordinal: number;
  brief: string;
  /** The track's scope type (backend/frontend/docs/…) — selects the review agents. */
  type: string;
  status: TrackStatus;
  /** Whether a just-in-time plan was generated — gates the optional `plan` leaf in the nav tree. */
  hasPlan: boolean;
  /** The track's steps (execute folder leaves), ordinal-sorted. */
  steps: PipelineStep[];
}

export interface PipelineJob {
  /** The thread id — the backend keys the pipeline on the thread (thread = the build unit). */
  threadId: string;
  title: string;
  kind: JobKind;
  status: JobStatus;
  decisionRecordId: string | null;
  /** The opened PR (ARTIFACTS), or null until the PR-tail stage opens one. */
  prUrl: string | null;
  prNumber: number | null;
  /** The feature branch all tracks stack on (header), or null before the sandbox is cut. */
  featureBranch: string | null;
  baseBranch: string | null;
  tracks: PipelineTrack[];
}

export type PipelineState = PipelineJob | { status: 'no_job' };

// ── Context files (`…/threads/:threadId/context`) ────────────────────────────────────────────────
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
export interface ThreadContext {
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

// ── UI thread model ────────────────────────────────────────────────────────────────────────────
/** UI status set from handoff §7 (semantic dot colors). */
export type ThreadStatus =
  | 'running'
  | 'scoping'
  | 'plan_review'
  | 'awaiting_approval'
  | 'done'
  | 'triaging'
  | 'paused'
  | 'failed';

/** UI kind badge — `feat`/`fix` from JobKind; `event` denotes a notification-seeded thread. */
export type ThreadKind = 'feat' | 'fix' | 'event';
