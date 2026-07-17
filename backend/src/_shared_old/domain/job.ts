import type { AutoApproveMode, JobActivity, JobHalt, JobStatus } from '@workspace/shared';
import { JOB_ACTIVITIES } from '@workspace/shared';
import type { ThreadType } from '../thread-kind/thread-types';
export { JOB_ACTIVITIES };
export type { JobActivity, JobHalt, JobStatus };

export type ThreadOrigin = 'chat' | 'event' | 'control';

export type JobProvenance = { jobId: string; title: string | null };

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'deleting', 'archived']);
const OPERATOR_OWNED_STATUSES = new Set([
  'open',
  'planning',
  'awaiting_approval',
  'awaiting_ship_review',
  'amending',
]);

export function deriveNeedsYou(i: {
  status: string;
  activity: JobActivity;
  openQuestion: boolean;
  awaitingSecret: boolean;
  halted: boolean; // halted === true OR halt != null
}): boolean {
  if (TERMINAL_STATUSES.has(i.status)) return false;
  if (i.halted) return true;
  if (i.activity !== 'idle') return false;
  if (i.openQuestion || i.awaitingSecret) return true;
  return OPERATOR_OWNED_STATUSES.has(i.status);
}

export type JobKind = 'feature' | 'bugfix' | 'onboarding' | 'event' | 'review';

export interface Job {
  id: string;
  orgId: string;
  repoId: string;
  origin: ThreadOrigin;
  surfaceThreadRef: string | null;
  title: string | null;
  baseBranch: string | null;
  kind: JobKind | null;
  buildPath: 'direct' | 'plan' | null;
  status: JobStatus;
  activity: JobActivity;
  halt: JobHalt | null;
  decisionRecordId: string | null;
  featureBranch: string | null;
  currentBranch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  shipReviewApprovedAt: Date | null;
  autoApproveMode: AutoApproveMode;
  autoApproveBy: string | null;
  autoMerge: boolean;
  autoMergeBy: string | null;
  createdBy: JobProvenance | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TranscriptMessage {
  id: string;
  jobId: string;
  author: string;
  authorId: string;
  authorBotId: string | null;
  text: string;
  createdAt: Date;
}

export const CODEX_REVIEW_OUTAGE_RETRY_MS = 5 * 60_000;

export type ThreadStatus =
  | 'pending' // not started
  | 'planning' // the thread's single step is being locked
  | 'reviewing' // Codex plan-review loop
  | 'executing' // the orchestrator turn is running
  | 'auto_fixing' // per-thread auto-fix stage (a builder while its review children run)
  | 'done';

export type ThreadCondition = 'none' | 'paused' | 'incomplete' | 'failed' | 'skipped';

export interface Thread {
  id: string;
  jobId: string;
  ordinal: number;
  brief: string;
  plan: string | null;
  orientation: string | null;
  handoffIn: string | null;
  handoffOut: string | null;
  status: ThreadStatus;
  condition: ThreadCondition;
  kind: string;
  threadGroupId: string;
  type: ThreadType;
  parentThreadId: string | null;
  startSha: string | null;
}

export type StepStatus = 'pending' | 'building' | 'reviewing' | 'done';

export interface Step {
  id: string;
  threadId: string;
  jobId: string;
  ordinal: number;
  title: string | null;
  brief: string;
  stage: string;
  status: StepStatus;
  sessionId: string | null;
  batchOrdinal: number | null;
  legOrdinal: number;
  commitSha: string | null;
}
