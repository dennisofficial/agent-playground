import { vi } from 'vitest';
import type { EmployeeRegistry } from '../../employees/employee.registry';
import type { BoardStore, BoardTask } from '../../memory/board-store';
import type { TicketNoteStore } from '../../memory/ticket-note-store';
import type { GithubApiService } from '../../projects/github-api.service';
import type { GithubTokenStore } from '../../projects/github-token-store';
import type { ProjectRecord } from '../../projects/project.types';
import type { WorktreeService } from '../../worktrees/worktree.service';
import type { Worktree } from '../../worktrees/worktree.types';
import type { HarnessToolContext } from '../tool.types';
import { MarkPrReadyTool } from './mark-pr-ready.tool';

const WT: Worktree = {
  id: 'wt-001',
  name: 'feature',
  branch: 'agent/alex/wt-001-feature',
  baseRef: 'abc',
  path: '/repos/proj/.worktrees/wt-001-feature',
  checkout: '/repos/proj/.worktrees/wt-001-feature',
  ownerBot: 'alex',
  team: 'local',
  project: 'proj',
  repoRoot: '/repos/proj',
  sharedBranch: 'shared/feat',
};

const REC: ProjectRecord = {
  teamId: 'local',
  projectId: 'proj',
  displayName: 'Proj',
  gitUrl: 'https://github.com/dennis/proj',
  defaultBranch: 'main',
  tokenName: null,
  createdAt: '',
  updatedAt: '',
};

const task = (p: Partial<BoardTask>): BoardTask => ({
  id: 7,
  project: 'proj',
  title: 'Wire auth',
  description: '',
  status: 'approved',
  assignee: 'alex',
  createdBy: 'sam',
  dependsOn: [],
  createdAt: '',
  updatedAt: '',
  ...p,
});

const ctx = (selfAgent: string): HarnessToolContext =>
  ({
    identity: { team: 'local', selfAgent, project: 'proj', surface: 'chan' },
  }) as never;

function build(opts: {
  boardTask?: BoardTask;
  prs?: Array<{ number: number; url: string; headBranch: string }>;
  isLead?: boolean;
  markReadyError?: string;
  owners?: Array<{ employee: string; sessionId?: string }>;
}) {
  const markReady = vi.fn(async () => {
    if (opts.markReadyError) throw new Error(opts.markReadyError);
    return { isDraft: false };
  });
  const worktrees = {
    get: () => WT,
    projectRecordFor: async () => REC,
  } as unknown as WorktreeService;
  const tokens = {
    resolve: async () => ({ name: 'default', token: 'SECRET' }),
  } as unknown as GithubTokenStore;
  const github = {
    listOpenPullRequests: async () =>
      opts.prs ?? [
        { number: 9, url: 'https://gh/pull/9', headBranch: 'shared/feat' },
      ],
    markReadyForReview: markReady,
  } as unknown as GithubApiService;
  const boardUpdates: unknown[] = [];
  const board = {
    get: async () => opts.boardTask ?? task({ status: 'approved' }),
    update: vi.fn(async (_t: string, _id: number, patch: unknown) => {
      boardUpdates.push(patch);
      return task(patch as Partial<BoardTask>);
    }),
  } as unknown as BoardStore;
  const noted: unknown[] = [];
  const notes = {
    add: async (_t: string, _id: number, _a: string, body: string) =>
      void noted.push(body),
  } as unknown as TicketNoteStore;
  const employees = {
    byId: (id: string) => ({ id, teamLead: !!opts.isLead && id === 'sam' }),
  } as unknown as EmployeeRegistry;
  const emitted: Array<Record<string, unknown>> = [];
  const boardEvents = {
    emit: (e: Record<string, unknown>) => void emitted.push(e),
  } as never;
  const plans = {
    listForTask: async () =>
      opts.owners ?? [{ employee: 'alex', sessionId: 'sess-1' }],
  } as never;
  const sessions = {
    get: async (sid: string) => ({ notifyThread: `room-${sid}` }),
  } as never;
  return {
    tool: new MarkPrReadyTool(
      worktrees,
      tokens,
      github,
      board,
      notes,
      employees,
      plans,
      boardEvents,
      sessions,
    ),
    markReady,
    board,
    boardUpdates,
    noted,
    emitted,
  };
}

describe('mark_pr_ready tool', () => {
  it('marks the PR ready, flips the ticket to in_review, and notes the PR url', async () => {
    const { tool, markReady, board, boardUpdates, noted } = build({
      boardTask: task({ status: 'approved', assignee: 'alex' }),
    });
    const out = await tool.execute(
      { worktreeId: 'wt-001', board_task_id: 7 },
      ctx('alex'),
    );
    expect(markReady).toHaveBeenCalledWith('SECRET', {
      owner: 'dennis',
      repo: 'proj',
      number: 9,
    });
    expect(boardUpdates).toEqual([{ status: 'in_review' }]);
    expect(noted[0]).toContain('https://gh/pull/9');
    expect(out).toContain('in_review');
    void board;
  });

  it('refuses a non-owner who is not the lead', async () => {
    const { tool, markReady } = build({
      boardTask: task({ status: 'approved', assignee: 'alex' }),
    });
    const out = await tool.execute(
      { worktreeId: 'wt-001', board_task_id: 7 },
      ctx('riley'),
    );
    expect(out).toContain('only they or the team lead');
    expect(markReady).not.toHaveBeenCalled();
  });

  it('refuses unapproved work (nothing to mark ready)', async () => {
    const { tool, markReady } = build({
      boardTask: task({ status: 'planning', assignee: 'alex' }),
    });
    const out = await tool.execute(
      { worktreeId: 'wt-001', board_task_id: 7 },
      ctx('alex'),
    );
    expect(out).toContain('not in execution');
    expect(markReady).not.toHaveBeenCalled();
  });

  it('reports when no open PR matches the shared branch', async () => {
    const { tool } = build({
      boardTask: task({ status: 'approved', assignee: 'alex' }),
      prs: [{ number: 1, url: 'x', headBranch: 'other/branch' }],
    });
    const out = await tool.execute(
      { worktreeId: 'wt-001', board_task_id: 7 },
      ctx('alex'),
    );
    expect(out).toContain('No open PR found for shared/feat');
  });

  it('already in_review: marks ready again without a redundant board write', async () => {
    const { tool, boardUpdates } = build({
      boardTask: task({ status: 'in_review', assignee: 'alex' }),
    });
    await tool.execute({ worktreeId: 'wt-001', board_task_id: 7 }, ctx('alex'));
    expect(boardUpdates).toEqual([]); // already in_review → no update
  });

  it('emits pr-ready to EVERY owner (narration + the conductor slot-free rescan)', async () => {
    const { tool, emitted } = build({
      boardTask: task({ status: 'self_review', assignee: 'alex' }),
      owners: [
        { employee: 'alex', sessionId: 'sess-a' },
        { employee: 'riley', sessionId: 'sess-r' },
      ],
    });
    await tool.execute({ worktreeId: 'wt-001', board_task_id: 7 }, ctx('alex'));
    const ready = emitted.filter((e) => e.kind === 'pr-ready');
    expect(ready.map((e) => e.employee)).toEqual(['alex', 'riley']);
    expect(ready[0]).toMatchObject({
      team: 'local',
      taskId: 7,
      prUrl: 'https://gh/pull/9',
      notifyThread: 'room-sess-a',
    });
  });

  it('ships from self_review (the post-self-review ship decision)', async () => {
    const { tool, markReady, boardUpdates } = build({
      boardTask: task({ status: 'self_review', assignee: 'alex' }),
    });
    await tool.execute({ worktreeId: 'wt-001', board_task_id: 7 }, ctx('alex'));
    expect(markReady).toHaveBeenCalled();
    expect(boardUpdates).toEqual([{ status: 'in_review' }]);
  });
});
