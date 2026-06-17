import { vi } from 'vitest';
import type { EmployeeRegistry } from '../../employees/employee.registry';
import type { BoardStore, BoardTask } from '../../memory/board-store';
import type { ReviewPipelineService } from '../../sessions/review-pipeline.service';
import type { HarnessToolContext } from '../tool.types';
import { MarkPrReadyTool } from './mark-pr-ready.tool';

const task = (p: Partial<BoardTask>): BoardTask => ({
  id: 7,
  project: 'proj',
  title: 'Wire auth',
  description: '',
  status: 'self_review',
  assignee: 'alex',
  createdBy: 'atlas',
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
  isLead?: boolean;
  ship?: { ok: boolean; reason?: string };
}) {
  const board = {
    get: async () => opts.boardTask ?? task({}),
  } as unknown as BoardStore;
  const employees = {
    byId: (id: string) => ({ id, teamLead: !!opts.isLead && id === 'atlas' }),
  } as unknown as EmployeeRegistry;
  const shipSharedPr = vi.fn(async () => opts.ship ?? { ok: true });
  const reviewPipeline = { shipSharedPr } as unknown as ReviewPipelineService;
  return {
    tool: new MarkPrReadyTool(board, employees, reviewPipeline),
    shipSharedPr,
  };
}

describe('mark_pr_ready tool', () => {
  it('delegates the ship to shipSharedPr and reports in_review on success', async () => {
    const { tool, shipSharedPr } = build({
      boardTask: task({ status: 'self_review', assignee: 'alex' }),
    });
    const out = await tool.execute(
      { worktreeId: 'wt-001', board_task_id: 7 },
      ctx('alex'),
    );
    expect(shipSharedPr).toHaveBeenCalledWith('local', 7);
    expect(out).toContain("Dennis's now");
  });

  it('surfaces a ship failure (no silent success)', async () => {
    const { tool } = build({
      boardTask: task({ status: 'self_review', assignee: 'alex' }),
      ship: { ok: false, reason: 'no open PR found for shared/feat' },
    });
    const out = await tool.execute(
      { worktreeId: 'wt-001', board_task_id: 7 },
      ctx('alex'),
    );
    expect(out).toContain('no open PR found for shared/feat');
  });

  it('refuses a non-owner who is not the lead (never ships)', async () => {
    const { tool, shipSharedPr } = build({
      boardTask: task({ status: 'self_review', assignee: 'alex' }),
    });
    const out = await tool.execute(
      { worktreeId: 'wt-001', board_task_id: 7 },
      ctx('riley'),
    );
    expect(out).toContain('only they or the team lead');
    expect(shipSharedPr).not.toHaveBeenCalled();
  });

  it('lets the team lead ship anyone’s PR', async () => {
    const { tool, shipSharedPr } = build({
      boardTask: task({ status: 'self_review', assignee: 'alex' }),
      isLead: true,
    });
    await tool.execute({ worktreeId: 'wt-001', board_task_id: 7 }, ctx('atlas'));
    expect(shipSharedPr).toHaveBeenCalledWith('local', 7);
  });

  it('refuses work that is not in execution (nothing to ready)', async () => {
    const { tool, shipSharedPr } = build({
      boardTask: task({ status: 'planning', assignee: 'alex' }),
    });
    const out = await tool.execute(
      { worktreeId: 'wt-001', board_task_id: 7 },
      ctx('alex'),
    );
    expect(out).toContain('not in execution');
    expect(shipSharedPr).not.toHaveBeenCalled();
  });
});
