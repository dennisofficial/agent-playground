import { describe, expect, it } from 'bun:test';
import {
  EPhaseKind,
  ESessionEndReason,
  EThreadRole,
  EThreadStatus,
} from '../../../generated/prisma/enums.js';
import { formatThreadTree } from '../thread-tree.js';
import type { CliJobView, CliThreadView } from '../../views.js';

function thread(over: Partial<CliThreadView> = {}): CliThreadView {
  return {
    id: 'thread-1',
    role: EThreadRole.charting,
    status: EThreadStatus.active,
    messageCount: 4,
    createdAt: new Date('2026-08-11T10:00:00.000Z'),
    closedAt: null,
    sessions: [{ ordinal: 1, endReason: null }],
    ...over,
  };
}

const JOB: CliJobView = {
  id: 'job-1',
  title: 'testing',
  branch: null,
  workspacePath: null,
  phases: [
    {
      id: 'phase-0',
      kind: EPhaseKind.charting,
      current: false,
      threads: [
        thread({
          id: 'thread-1',
          status: EThreadStatus.closed,
          closedAt: new Date('2026-08-11T11:00:00.000Z'),
          sessions: [
            { ordinal: 1, endReason: ESessionEndReason.context_pressure },
            { ordinal: 2, endReason: ESessionEndReason.thread_closed },
          ],
        }),
      ],
    },
    {
      id: 'phase-1',
      kind: EPhaseKind.planning,
      current: true,
      threads: [thread({ id: 'thread-2', role: EThreadRole.planner, messageCount: 12 })],
    },
  ],
};

describe('formatThreadTree', () => {
  const text = formatThreadTree(JOB);

  it('leads with the job and the totals a reader needs before the tree', () => {
    expect(text.split('\n')[0]).toBe('job job-1  testing');
    expect(text).toContain('phases 2  threads 2  messages 16');
  });

  it('marks the current phase — the one an agent is standing in', () => {
    expect(text).toContain('phase planning  (current)  id=phase-1');
    expect(text).toContain('phase charting  id=phase-0');
  });

  it('prints thread ids in full, because they are the argument to `atlas transcript`', () => {
    expect(text).toContain('thread thread-2  role=planner  status=active  messages=12  sessions=1');
  });

  it('names why each session ended, which is the archaeology', () => {
    expect(text).toContain('session 1  ended=context_pressure');
    expect(text).toContain('session 2  ended=thread_closed');
    expect(text).toContain('session 1  open');
  });

  it('is plain text for a model — no box drawing, no colour', () => {
    expect(text).not.toMatch(/[│├└─┌┐┘┤┬┴┼]/);
  });

  it('shows a phase that has no threads yet rather than hiding it', () => {
    const empty = formatThreadTree({
      ...JOB,
      phases: [{ id: 'phase-2', kind: EPhaseKind.build, current: true, threads: [] }],
    });
    expect(empty).toContain('phase build  (current)  id=phase-2');
    expect(empty).toContain('(no threads yet)');
  });

  it('omits workspace and branch when the job has neither, and prints them when it does', () => {
    expect(text).not.toContain('branch');
    const worktree = formatThreadTree({
      ...JOB,
      branch: 'atlas/job-1',
      workspacePath: '/Users/dennis/Developer/atlas/.worktrees/job-1',
    });
    expect(worktree).toContain('branch atlas/job-1');
    expect(worktree).toContain('workspace /Users/dennis/Developer/atlas/.worktrees/job-1');
  });
});
