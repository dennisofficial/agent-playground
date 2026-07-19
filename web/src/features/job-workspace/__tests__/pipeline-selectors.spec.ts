import {
  EJobActivity,
  EJobKind,
  EJobStatus,
  EThreadCondition,
  EThreadGroupKind,
  EThreadOrigin,
  EThreadRole,
  EThreadStatus,
  EThreadType,
  ETaskStatus,
  type JobView,
  type TaskView,
  type ThreadGroupView,
  type ThreadView,
} from '@workspace/shared';
import { describe, expect, it } from 'vitest';
import type { Pipeline } from '@/lib/api/types';
import {
  activeJob,
  isMasterReviewThread,
  isNoJob,
  jobBuildPath,
  jobHalt,
  mainTasks,
  sortedThreads,
  tasksForGroup,
  threadAcceptsOperatorInput,
} from '../lib/pipeline-selectors';

function task(over: Partial<TaskView> & Pick<TaskView, 'threadGroupId' | 'ordinal' | 'title'>): TaskView {
  return {
    id: `task-${over.ordinal}`,
    jobId: 'j1',
    brief: null,
    activeForm: null,
    status: ETaskStatus.PENDING,
    blockedBy: [],
    ...over,
  };
}

function thread(over: Partial<ThreadView> & Pick<ThreadView, 'id' | 'threadGroupId' | 'role' | 'ordinal'>): ThreadView {
  return {
    jobId: 'j1',
    type: EThreadType.GENERAL,
    parentThreadId: null,
    brief: '',
    status: EThreadStatus.PENDING,
    condition: EThreadCondition.NONE,
    sessionId: null,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...over,
  };
}

function group(over: Partial<ThreadGroupView> & Pick<ThreadGroupView, 'id' | 'kind' | 'ordinal'>): ThreadGroupView {
  return {
    jobId: 'j1',
    title: null,
    type: null,
    status: EThreadStatus.PENDING,
    condition: EThreadCondition.NONE,
    threads: [],
    ...over,
  };
}

function job(status: EJobStatus, threadGroups: ThreadGroupView[]): JobView {
  return {
    id: 'j1',
    orgId: 'o1',
    repoId: 'r1',
    title: 'A job',
    status,
    activity: EJobActivity.IDLE,
    kind: EJobKind.FEATURE,
    origin: EThreadOrigin.CHAT,
    focusedThreadId: null,
    archivedAt: null,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    threadGroups,
  };
}

describe('isNoJob / activeJob', () => {
  it('treats an open job as no_job (never entered the build lifecycle)', () => {
    expect(isNoJob(job(EJobStatus.OPEN, []))).toBe(true);
    expect(isNoJob(job(EJobStatus.RUNNING, []))).toBe(false);
  });

  it('activeJob mirrors the old pipelineJob() null-for-open / null-while-loading', () => {
    expect(activeJob(undefined)).toBeNull();
    const openPipeline: Pipeline = { job: job(EJobStatus.OPEN, []), tasks: [] };
    expect(activeJob(openPipeline)).toBeNull();
    const running = job(EJobStatus.RUNNING, []);
    expect(activeJob({ job: running, tasks: [] })).toBe(running);
  });
});

describe('tasksForGroup', () => {
  it('folds the flat task feed into one group and projects the ordinal as the display id', () => {
    const tasks = [
      task({ threadGroupId: 'g1', ordinal: 1, title: 'First', brief: 'do the first thing' }),
      task({ threadGroupId: 'g2', ordinal: 2, title: 'Other group' }),
      task({ threadGroupId: 'g1', ordinal: 3, title: 'Third' }),
    ];
    const result = tasksForGroup(tasks, 'g1');
    expect(result).toEqual([
      { id: '1', subject: 'First', status: 'pending', description: 'do the first thing', blockedBy: [] },
      { id: '3', subject: 'Third', status: 'pending', blockedBy: [] },
    ]);
  });
});

describe('mainTasks', () => {
  it('reads the planning thread group’s own tasks', () => {
    const planning = group({ id: 'plan', kind: EThreadGroupKind.PLANNING, ordinal: 0 });
    const build = group({ id: 'build', kind: EThreadGroupKind.BUILD, ordinal: 1 });
    const pipeline: Pipeline = {
      job: job(EJobStatus.RUNNING, [planning, build]),
      tasks: [
        task({ threadGroupId: 'plan', ordinal: 1, title: 'Plan task' }),
        task({ threadGroupId: 'build', ordinal: 2, title: 'Build task' }),
      ],
    };
    expect(mainTasks(pipeline).map((t) => t.subject)).toEqual(['Plan task']);
    expect(mainTasks(undefined)).toEqual([]);
  });
});

describe('thread role derivations', () => {
  it('identifies the master-review thread', () => {
    expect(
      isMasterReviewThread(thread({ id: 't1', threadGroupId: 'g1', role: EThreadRole.MASTER_REVIEW, ordinal: 0 })),
    ).toBe(true);
    expect(
      isMasterReviewThread(thread({ id: 't2', threadGroupId: 'g1', role: EThreadRole.BUILDER, ordinal: 0 })),
    ).toBe(false);
  });

  it('gates operator chat to builders + planning', () => {
    expect(threadAcceptsOperatorInput(EThreadRole.BUILDER)).toBe(true);
    expect(threadAcceptsOperatorInput(EThreadRole.PLANNING)).toBe(true);
    expect(threadAcceptsOperatorInput(EThreadRole.REVIEW_AGENT)).toBe(false);
  });

  it('sorts a group’s threads by ordinal', () => {
    const g = group({
      id: 'g1',
      kind: EThreadGroupKind.BUILD,
      ordinal: 0,
      threads: [
        thread({ id: 'b', threadGroupId: 'g1', role: EThreadRole.BUILDER, ordinal: 2 }),
        thread({ id: 'a', threadGroupId: 'g1', role: EThreadRole.BUILDER, ordinal: 1 }),
      ],
    });
    expect(sortedThreads(g).map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('backend not-yet-emitted selectors stay dark', () => {
  it('returns neutral values until the read model carries them', () => {
    const j = job(EJobStatus.RUNNING, []);
    expect(jobHalt(j)).toBeNull();
    expect(jobBuildPath(j)).toBeNull();
  });
});
