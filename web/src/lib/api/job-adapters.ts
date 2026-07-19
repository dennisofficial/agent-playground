import {
  EJobKind,
  JobView,
  TaskView,
  ThreadGroupView,
  ThreadMessageView,
  ThreadView,
} from '@workspace/shared';
import type { JobMessage } from './job-api';
import type {
  PipelineJob,
  PipelineState,
  PipelineThread,
  PipelineThreadGroup,
  TaskItem,
  ThreadGroupKind,
  WebCard,
} from './types';

function toTaskItem(t: TaskView): TaskItem {
  return {
    // The LLM addresses tasks by a simple per-checklist integer (the live task tool's `taskId`), not the
    // durable uuid — so surface the ordinal as the id the navigator renders (`#1`, `#2`, …).
    id: String(t.ordinal),
    subject: t.title,
    status: t.status,
    description: t.brief ?? undefined,
    activeForm: t.activeForm ?? undefined,
    blockedBy: t.blockedBy,
  };
}

function toPipelineThread(t: ThreadView): PipelineThread {
  return {
    id: t.id,
    role: t.role,
    ordinal: t.ordinal,
    brief: t.brief,
    type: t.type,
    status: t.status,
    condition: t.condition,
    hasPlan: false,
    sessionId: t.sessionId,
    commitSha: null,
    // Static per-role chat gate (mirrors the backend default): builders + planning accept operator input.
    operatorInput: t.role === 'builder' || t.role === 'planning',
    isMasterReview: t.role === 'master_review',
    // Review children arrive via `parentThreadId`; the current read model keeps them as flat rows, so a
    // thread has no pre-nested children (they render as their own top-level rows).
    children: [],
  };
}

function toPipelineThreadGroup(g: ThreadGroupView, tasks: TaskView[]): PipelineThreadGroup {
  return {
    id: g.id,
    kind: g.kind as ThreadGroupKind,
    title: g.title,
    type: g.type,
    ordinal: g.ordinal,
    status: g.status,
    condition: g.condition,
    decisionRecordId: null,
    threads: [...g.threads].sort((a, b) => a.ordinal - b.ordinal).map(toPipelineThread),
    tasks: tasks.filter((t) => t.threadGroupId === g.id).map(toTaskItem),
  };
}

/** Project a job detail (+ its tasks) into the `PipelineState` the navigator renders. An `open` job (no
 *  build lifecycle yet) becomes the `no_job` shape carrying its planning checklist. */
export function jobViewToPipeline(job: JobView, tasks: TaskView[]): PipelineState {
  const threadGroups = [...job.threadGroups]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((g) => toPipelineThreadGroup(g, tasks));

  if (job.status === 'open') {
    return {
      status: 'no_job',
      mainTasks: threadGroups.find((s) => s.kind === 'planning')?.tasks ?? [],
      autoApproveMode: 'off',
      autoMerge: false,
      mergeReady: false,
      mergeValue: null,
      blockedSeedMessage: null,
    };
  }

  const hasBuild = threadGroups.some((s) => s.kind === 'build' || s.kind === 'direct_build');
  const pipeline: PipelineJob = {
    jobId: job.id,
    title: job.title ?? 'Untitled thread',
    kind: job.kind ?? EJobKind.FEATURE,
    status: job.status,
    halt: null,
    createdBy: null,
    blockedBy: [],
    blockedSeedMessage: null,
    buildPath: hasBuild ? 'plan' : null,
    autoApproveMode: 'off',
    autoMerge: false,
    mergeReady: false,
    mergeValue: null,
    decisionRecordId: null,
    planReview: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prMergeable: null,
    ciStatus: null,
    ciCounts: null,
    featureBranch: null,
    currentBranch: null,
    baseBranch: null,
    threadGroups,
    priorRevisions: [],
  };
  return pipeline;
}

/** Project a durable message view onto the conversation's normalized `JobMessage`. */
export function threadMessageToJobMessage(v: ThreadMessageView): JobMessage {
  return {
    ts: v.id,
    threadId: v.threadId,
    subagentId: v.subagentId,
    subagentStatus: v.subagentStatus ?? null,
    subagentEndedAt: v.subagentEndedAt ?? null,
    author: v.isAtlas ? 'atlas' : 'user',
    authorId: v.authorId,
    authorName: v.author,
    text: v.text ?? '',
    kind: v.kind,
    source: v.source,
    card: (v.card ?? undefined) as WebCard | undefined,
    meta: v.meta ?? undefined,
    postedAt: v.postedAt,
    orderAt: v.orderAt,
  };
}
