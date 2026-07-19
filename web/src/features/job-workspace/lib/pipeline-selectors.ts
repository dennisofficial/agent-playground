import {
  EJobStatus,
  EThreadGroupKind,
  EThreadRole,
  type AutoApproveMode,
  type JobHalt,
  type JobView,
  type TaskView,
  type ThreadGroupView,
  type ThreadView,
} from '@workspace/shared';
import type {
  CiCounts,
  CiStatus,
  JobBlocker,
  JobProvenance,
  LaneDefaultFooter,
  Pipeline,
  PipelineReviewChild,
  PrState,
  TaskItem,
} from '@/lib/api/types';

/**
 * PIPELINE SELECTORS — pure functions over the shared job DTOs (`@workspace/shared`), the single home for
 * everything the navigator/step-view/pipeline-tree derive from a job read. Replaces the old
 * `job-adapters.ts`/`PipelineJob` view-model: components now import the shared `JobView`/`ThreadGroupView`/
 * `ThreadView`/`TaskView` directly and call these to (a) derive real view fields (task-join, role flags,
 * `no_job` discrimination) or (b) read a field the backend read model doesn't emit yet — each such field is
 * a one-line `TODO(backend)` selector so the (currently dark) UI that depends on it stays intact and
 * greppable, and lights up automatically once `JobView`/`ThreadView` start carrying it.
 */

// ─── Derivable now (real view logic) ──────────────────────────────────────────────────────────────

/** An open job is still a conversation — it never entered the build lifecycle (the old `no_job` shape). */
export function isNoJob(job: JobView): boolean {
  return job.status === EJobStatus.OPEN;
}

/**
 * The job once it has entered the build lifecycle, or `null` while it's still an open conversation — the
 * direct replacement for the old `pipelineJob()` (which returned null for the `no_job` shape). Also null
 * while the pipeline is still loading (no data yet), so `job?.`/`job && …` guards keep working unchanged.
 */
export function activeJob(pipeline: Pipeline | undefined): JobView | null {
  if (!pipeline || isNoJob(pipeline.job)) return null;
  return pipeline.job;
}

/** A job's thread groups in pipeline (ordinal) order. */
export function sortedThreadGroups(job: JobView): ThreadGroupView[] {
  return [...job.threadGroups].sort((a, b) => a.ordinal - b.ordinal);
}

/** A thread group's threads in ordinal order (a build group's sequential builder legs, oldest first). */
export function sortedThreads(group: ThreadGroupView): ThreadView[] {
  return [...group.threads].sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Project one durable task row onto the navigator's {@link TaskItem} — the reduced shape the live task
 * overlay (`live-tasks.ts`) and the durable feed share. The id is the per-checklist ORDINAL (the live
 * task tool's `taskId`, rendered `#1`/`#2`), NOT the durable uuid, so the two folds key on the same id.
 */
function toTaskItem(t: TaskView): TaskItem {
  return {
    id: String(t.ordinal),
    subject: t.title,
    status: t.status,
    description: t.brief ?? undefined,
    activeForm: t.activeForm ?? undefined,
    blockedBy: t.blockedBy,
  };
}

/** The tasks owned by one thread group — tasks arrive as a flat, separate feed, folded in by group id
 *  (they're owned by the thread group so they survive builder-leg rotation). */
export function tasksForGroup(tasks: TaskView[], groupId: string): TaskItem[] {
  return tasks.filter((t) => t.threadGroupId === groupId).map(toTaskItem);
}

/** The Main brain session's checklist — the planning thread group's own tasks (planning is always exactly
 *  one singleton thread group, present from job creation onward, so this works for an open/pre-plan job). */
export function mainTasks(pipeline: Pipeline | undefined): TaskItem[] {
  if (!pipeline) return [];
  const planning = pipeline.job.threadGroups.find((g) => g.kind === EThreadGroupKind.PLANNING);
  return planning ? tasksForGroup(pipeline.tasks, planning.id) : [];
}

/** Whether a thread's role accepts operator chat input AT ALL — a static per-role gate (builders +
 *  planning; false by default for the rest). */
export function threadAcceptsOperatorInput(role: EThreadRole): boolean {
  return role === EThreadRole.BUILDER || role === EThreadRole.PLANNING;
}

/** The whole-diff Codex master-review thread (rendered "Master review", no review children). */
export function isMasterReviewThread(t: ThreadView): boolean {
  return t.role === EThreadRole.MASTER_REVIEW;
}

// ─── Backend not-yet-emitted ──────────────────────────────────────────────────────────────────────
//
// `JobView`/`ThreadView` are currently a thin subset of the target read model. The fields below aren't on
// the wire yet, so each selector returns a neutral value and the UI that branches on it stays dark until
// the backend emits it. Kept as named selectors (not inline `null`s) so the whole gap greps as
// `TODO(backend)` and lights up field-by-field as the read model lands.

/** A prior plan revision as browsable history — a re-propose over already-DONE work forges one. */
export interface PriorRevision {
  decisionRecordId: string;
  revision: number;
  status: string;
  threadGroups: ThreadGroupView[];
}

/** TODO(backend): JobView does not carry `halt` yet. */
export function jobHalt(_job: JobView | null): JobHalt | null {
  return null;
}
/** TODO(backend): JobView does not carry `build_path` yet (so a direct build is never distinguished). */
export function jobBuildPath(_job: JobView | null): 'direct' | 'plan' | null {
  return null;
}
/** TODO(backend): JobView does not carry `pr_state` yet. */
export function jobPrState(_job: JobView | null): PrState | null {
  return null;
}
/** TODO(backend): JobView does not carry `pr_number` yet. */
export function jobPrNumber(_job: JobView | null): number | null {
  return null;
}
/** TODO(backend): JobView does not carry `pr_url` yet. */
export function jobPrUrl(_job: JobView | null): string | null {
  return null;
}
/** TODO(backend): JobView does not carry `pr_mergeable` yet. */
export function jobPrMergeable(_job: JobView | null): string | null {
  return null;
}
/** TODO(backend): JobView does not carry `ci_status` yet. */
export function jobCiStatus(_job: JobView | null): CiStatus | null {
  return null;
}
/** TODO(backend): JobView does not carry `ci_counts` yet. */
export function jobCiCounts(_job: JobView | null): CiCounts | null {
  return null;
}
/** TODO(backend): JobView does not carry the plan-review row yet. */
export function jobPlanReview(
  _job: JobView | null,
): { status: string; defaultFooter?: LaneDefaultFooter } | null {
  return null;
}
/** TODO(backend): JobView does not carry prior plan revisions yet. */
export function jobPriorRevisions(_job: JobView | null): PriorRevision[] {
  return [];
}
/** TODO(backend): JobView does not carry `feature_branch` yet. */
export function jobFeatureBranch(_job: JobView | null): string | null {
  return null;
}
/** TODO(backend): JobView does not carry the observed `current_branch` yet. */
export function jobCurrentBranch(_job: JobView | null): string | null {
  return null;
}
/** TODO(backend): JobView does not carry `base_branch` yet. */
export function jobBaseBranch(_job: JobView | null): string | null {
  return null;
}
/** TODO(backend): JobView does not carry the `created_by` provenance snapshot yet. */
export function jobCreatedBy(_job: JobView | null): JobProvenance | null {
  return null;
}
/** TODO(backend): JobView does not carry live blockers yet. */
export function jobBlockedBy(_job: JobView | null): JobBlocker[] {
  return [];
}
/** TODO(backend): JobView does not carry the born-blocked `blocked_seed_message` yet. */
export function jobBlockedSeedMessage(_job: JobView | null): string | null {
  return null;
}
/** TODO(backend): JobView does not carry the active `decision_record_id` yet. */
export function jobDecisionRecordId(_job: JobView | null): string | null {
  return null;
}
/** TODO(backend): JobView does not carry the per-job auto-approve mode yet. */
export function jobAutoApproveMode(_job: JobView | null): AutoApproveMode {
  return 'off';
}
/** TODO(backend): JobView does not carry the auto-merge settings / manual-merge gate yet. */
export function jobAutoMerge(_job: JobView | null): {
  autoMerge: boolean;
  mergeReady: boolean;
  mergeValue: string | null;
} {
  return { autoMerge: false, mergeReady: false, mergeValue: null };
}
/** TODO(backend): ThreadView does not carry pre-nested review children yet — the review path stays dark. */
export function threadChildren(_t: ThreadView): PipelineReviewChild[] {
  return [];
}
/** TODO(backend): ThreadView does not carry the lane's pre-turn composer-footer default yet. */
export function threadDefaultFooter(_t: ThreadView): LaneDefaultFooter | undefined {
  return undefined;
}
/** TODO(backend): the Main lane's pre-turn composer-footer default isn't emitted yet. */
export function mainDefaultFooter(_pipeline: Pipeline | undefined): LaneDefaultFooter | undefined {
  return undefined;
}
