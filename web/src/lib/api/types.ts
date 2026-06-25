/**
 * Contracts for the Atlas web surface (`/web/*`). These MIRROR the backend shapes verbatim:
 *  - `WebApprovalCard` / `WebVerdictCard` — the approval-card payload carried on a message's `card`.
 *  - `PipelineState` — `DriverStoreService.getPipelineState` (job + sections + per-section phases; carries
 *    the thread's PR url/number + feature/base branch — the navigator's ARTIFACTS + header read them).
 *
 * The live message + request shapes are owned by `thread-api.ts` (the org → repo → thread client).
 */

// ── Backend enums ──────────────────────────────────────────────────────────────────────────────
export type JobStatus =
  | 'scoping'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export type JobKind = 'feature' | 'bugfix';

export type SectionStatus =
  | 'pending'
  | 'planning'
  | 'reviewing'
  | 'awaiting_approval'
  | 'executing'
  | 'auto_fixing'
  | 'done'
  | 'failed';

/** Per-phase status (the execute folder's leaves). Mirrors backend `PhaseStatus` in `domain/thread.ts`. */
export type PhaseStatus =
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
  sections: string[];
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

export type WebCard = WebApprovalCard | WebVerdictCard;

// ── Pipeline (`…/threads/:threadId/pipeline`) ────────────────────────────────────────────────────
/** One phase of a section's locked plan — the execute folder's leaf (a Claude Code session). */
export interface PipelinePhase {
  id: string;
  ordinal: number;
  title: string | null;
  brief: string;
  /** The resumable cursor within the phase ('build' | 'review' | 'fix'). */
  step: string;
  status: PhaseStatus;
}

export interface PipelineSection {
  id: string;
  ordinal: number;
  brief: string;
  status: SectionStatus;
  /** Whether a just-in-time plan was generated — gates the optional `plan` leaf in the nav tree. */
  hasPlan: boolean;
  /** The section's phases (execute folder leaves), ordinal-sorted. */
  phases: PipelinePhase[];
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
  /** The feature branch all sections stack on (header), or null before the sandbox is cut. */
  featureBranch: string | null;
  baseBranch: string | null;
  sections: PipelineSection[];
}

export type PipelineState = PipelineJob | { status: 'no_job' };

// ── UI thread model ────────────────────────────────────────────────────────────────────────────
/** UI status set from handoff §7 (semantic dot colors). */
export type ThreadStatus =
  | 'running'
  | 'scoping'
  | 'awaiting_approval'
  | 'done'
  | 'triaging'
  | 'paused'
  | 'failed';

/** UI kind badge — `feat`/`fix` from JobKind; `event` denotes a notification-seeded thread. */
export type ThreadKind = 'feat' | 'fix' | 'event';
