import { type ModelConfig, RealtimeRuleGuard, type Row } from '@workspace/pg-realtime';
import type { JobHalt, JobStatus } from '@workspace/shared';
import {
  deriveNeedsYou,
  JOB_ACTIVITIES,
  type JobActivity,
  type JobProvenance,
} from '../../_shared/domain/job';
import { CiCounts } from '../git/github-pr.service';

export interface RealtimePrincipal {
  userId: string;
  orgIds: string[];
}

export interface ThreadRealtimeRow extends Row {
  jobId: string;
  title: string | null;
  origin: string;
  kind: string | null;
  status: JobStatus;
  activity: JobActivity;
  halted: boolean;
  needsYou: boolean;
  createdAt: string;
  orgId: string;
  repoId: string;
  featureBranch: string | null;
  currentBranch: string | null;
  ciStatus: string | null;
  ciCounts: CiCounts | null;
  prMergeable: string | null;
  prState: string | null;
  portState: string | null;
  buildStagesDone: number | null;
  buildStagesTotal: number | null;
  sectionFirstEntered: Partial<Record<JobStatus, string>> | null;
  shipping: boolean;
  halt: JobHalt | null;
  createdBy: JobProvenance | null;
}

class ThreadOrgGuard extends RealtimeRuleGuard<RealtimePrincipal, ThreadRealtimeRow> {
  canRead(
    user: RealtimePrincipal | null,
  ): { orgId: { $in: string[] }; status: { $ne: string } } | false {
    if (!user || user.orgIds.length === 0) return false;
    return { orgId: { $in: user.orgIds }, status: { $ne: 'archived' } };
  }
}

function mapRow(raw: Row): ThreadRealtimeRow {
  const status = String(raw.status) as JobStatus;
  const rawActivity = String(raw.activity ?? 'idle');
  const activity: JobActivity = (JOB_ACTIVITIES as readonly string[]).includes(rawActivity)
    ? (rawActivity as JobActivity)
    : 'idle';
  const openQuestion = Number(raw.open_question_count ?? 0) > 0;
  const awaitingSecret = raw.awaiting_secret_id != null || Number(raw.open_secret_count ?? 0) > 0;
  const halted = raw.halted === true;
  const createdAt = raw.created_at;
  return {
    jobId: String(raw.id),
    title: (raw.title as string | null) ?? null,
    origin: String(raw.origin),
    kind: (raw.kind as string | null) ?? null,
    status,
    activity,
    halted,
    needsYou: deriveNeedsYou({
      status,
      activity,
      openQuestion,
      awaitingSecret,
      halted: halted || raw.halt != null,
    }),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
    orgId: String(raw.org_id),
    repoId: String(raw.repo_id),
    featureBranch: (raw.feature_branch as string | null) ?? null,
    currentBranch: (raw.current_branch as string | null) ?? null,
    ciStatus: (raw.ci_status as string | null) ?? null,
    ciCounts: (raw.ci_counts as CiCounts | null) ?? null,
    prMergeable: (raw.pr_mergeable as string | null) ?? null,
    prState: (raw.pr_state as string | null) ?? null,
    portState: (raw.port_state as string | null) ?? null,
    buildStagesDone: raw.build_stages_done == null ? null : Number(raw.build_stages_done),
    buildStagesTotal: raw.build_stages_total == null ? null : Number(raw.build_stages_total),
    shipping: status === 'running' && raw.ship_review_approved_at != null,
    halt: (raw.halt as JobHalt | null) ?? null,
    createdBy: (raw.created_by as JobProvenance | null) ?? null,
    sectionFirstEntered:
      (raw.section_first_entered as Partial<Record<JobStatus, string>> | null) ?? null,
  };
}

export const THREADS_MODEL: ModelConfig<ThreadRealtimeRow> = {
  table: 'jobs',
  primaryKey: 'id',
  refetchOnUpdate: true,
  mapRow,
  guard: new ThreadOrgGuard(),
};
