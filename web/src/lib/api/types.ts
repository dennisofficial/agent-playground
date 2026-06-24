/**
 * Contracts for the Atlas web surface (`/web/*`). These MIRROR the backend shapes verbatim:
 *  - `WebApprovalCard` / `WebVerdictCard` — the approval-card payload carried on a message's `card`.
 *  - `PipelineState` — `DriverStoreService.getPipelineState` (job + sections; NO pr_url / branch / diff).
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
export interface PipelineSection {
  id: string;
  ordinal: number;
  brief: string;
  status: SectionStatus;
}

export interface PipelineJob {
  jobId: string;
  title: string;
  kind: JobKind;
  status: JobStatus;
  decisionRecordId: string | null;
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
