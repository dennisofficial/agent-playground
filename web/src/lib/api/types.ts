/**
 * Contracts for the Atlas web surface (`/web/*`). These MIRROR the backend shapes verbatim:
 *  - `WebOutboundMessage` / `WebApprovalCard` / `WebVerdictCard` — `backend/.../atlas-web-surface.ts`
 *    + `web-approval-card.ts`.
 *  - `PipelineState` — `DriverStoreService.getPipelineState` (note: NO pr_url / branch / diff).
 *  - build-event `meta` — `section-driver.service.ts` (NO threadId; see BACKEND_GAPS.md #3).
 *
 * `WebThreadSummary` is the ideal-but-unbuilt `/web/threads` read model — kept here so the UI codes
 * against the eventual contract while we derive a demo list from the outbox today.
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

// ── Outbound message + build-event meta ────────────────────────────────────────────────────────
export interface BuildEventMeta {
  kind: 'build_event';
  phaseId?: string;
  sectionOrdinal?: number;
  phaseOrdinal?: number;
  eventKind?: string;
}

export type OutboundMeta = BuildEventMeta | Record<string, unknown>;

export interface WebOutboundMessage {
  ts: string;
  channel: string;
  text: string;
  threadTs?: string;
  card?: WebCard;
  meta?: OutboundMeta;
  postedAt: string;
  /** Client-only: a human message the operator just sent (never echoed by history/SSE). */
  local?: boolean;
  /** Client-only author tag — outbound posts are 'atlas'; optimistic posts are 'user'. */
  author?: 'atlas' | 'user';
}

// ── Pipeline (real `/web/pipeline`, currently unreachable — no threadId; kept for the flip) ──────
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

/** The ideal `/web/threads` row (contract-ahead — derived from the outbox today). */
export interface WebThreadSummary {
  threadKey: string;
  channel: string;
  threadTs: string;
  threadId?: string;
  title: string;
  kind: ThreadKind;
  status: ThreadStatus;
  branch?: string;
  tracker?: string;
  meta?: string;
  /** Most-recent activity ts (for sort + "active" sub-line). */
  lastTs: string;
}

// ── Request bodies ─────────────────────────────────────────────────────────────────────────────
export interface SayRequest {
  channel: string;
  text: string;
  threadTs?: string;
  authorId?: string;
  authorName?: string;
  teamId?: string;
}

export interface ApproveRequest {
  actionId: ApprovalActionId;
  value: string;
  ruledBy: string;
  note?: string;
}
