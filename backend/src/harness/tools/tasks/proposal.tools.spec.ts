import type { Identity } from '../../domain/identity';
import type { PlanProposalEvent } from '../../approvals/proposal-presenter.port';
import { ProposalService } from '../../approvals/proposal.service';
import type { TaskPlan } from '../../memory/plan-store';
import { ApprovePlanTool, ProposePlanTool } from './proposal.tools';

/**
 * The lead's approval-pipeline tools: approve_plan (layer-1 sign-off) and propose_plan (layer-2,
 * the outbound port). Stores mocked; the guard LADDER and the presenter contract are the subject —
 * absent presenter and present() throw both degrade to the chat-words return, never an error.
 */

const identity = (selfAgent: string): { identity: Identity } => ({
  identity: {
    selfAgent,
    team: 'T1',
    project: 'proj',
    participants: ['dennis'],
    speaker: 'dennis',
    surface: 'slack:T1:C42',
    isChannel: true,
  },
});

const plan = (
  employee: string,
  leadStatus: 'pending' | 'approved',
): TaskPlan => ({
  id: 1,
  taskId: 7,
  employee,
  planMd: `${employee}'s plan body`,
  leadStatus,
  ownerStatus: 'executing',
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T00:00:00.000Z',
});

function makeFakes(opts: {
  taskStatus?: string;
  plans?: TaskPlan[];
  approveResult?: TaskPlan | undefined;
}) {
  const board = {
    get: vi.fn(() =>
      Promise.resolve(
        opts.taskStatus
          ? { id: 7, title: 'Wire the API', status: opts.taskStatus }
          : undefined,
      ),
    ),
    transition: vi.fn(() =>
      Promise.resolve({
        id: 7,
        title: 'Wire the API',
        status: 'awaiting_approval',
      }),
    ),
  };
  const plans = {
    listForTask: vi.fn(() => Promise.resolve(opts.plans ?? [])),
    approve: vi.fn(() => Promise.resolve(opts.approveResult)),
  };
  const employees = {
    byId: (id: string) =>
      ['atlas', 'alex'].includes(id)
        ? { id, name: id, teamLead: id === 'atlas' }
        : undefined,
  };
  return { board, plans, employees };
}

describe('approve_plan', () => {
  it('is lead-only and records the sign-off with a progress readout', async () => {
    const f = makeFakes({
      taskStatus: 'planning',
      approveResult: plan('alex', 'approved'),
      plans: [plan('alex', 'approved'), plan('riley', 'pending')],
    });
    const tool = new ApprovePlanTool(
      f.board as never,
      f.plans as never,
      f.employees as never,
    );
    expect(
      await tool.execute({ task_id: 7, employee: 'alex' }, identity('alex')),
    ).toContain("team lead's call");

    const out = await tool.execute(
      { task_id: 7, employee: 'alex' },
      identity('atlas'),
    );
    expect(out).toContain("Approved alex's plan on #7");
    expect(out).toContain('Still pending your review: riley');
    expect(f.plans.approve).toHaveBeenCalledWith('T1', 7, 'alex');
  });

  it('says when ALL plans are approved, and refuses a missing plan', async () => {
    const all = makeFakes({
      taskStatus: 'planning',
      approveResult: plan('alex', 'approved'),
      plans: [plan('alex', 'approved')],
    });
    const tool = new ApprovePlanTool(
      all.board as never,
      all.plans as never,
      all.employees as never,
    );
    expect(
      await tool.execute({ task_id: 7, employee: 'alex' }, identity('atlas')),
    ).toContain('All 1 plan(s) on #7 are now lead-approved');

    const missing = makeFakes({
      taskStatus: 'planning',
      approveResult: undefined,
    });
    const tool2 = new ApprovePlanTool(
      missing.board as never,
      missing.plans as never,
      missing.employees as never,
    );
    expect(
      await tool2.execute({ task_id: 7, employee: 'nora' }, identity('atlas')),
    ).toContain("No plan by 'nora'");
  });
});

describe('propose_plan', () => {
  const APPROVED_TWO = [plan('alex', 'approved'), plan('riley', 'approved')];

  function makeTool(opts: {
    taskStatus?: string;
    plans?: TaskPlan[];
    presenter?: { present: (e: PlanProposalEvent) => Promise<void> };
  }) {
    const f = makeFakes(opts);
    // The guard ladder + CAS + present now live in ProposalService; the tool maps its outcome.
    const proposals = new ProposalService(
      f.board as never,
      f.plans as never,
      opts.presenter as never,
    );
    const tool = new ProposePlanTool(
      f.board as never,
      f.employees as never,
      proposals,
    );
    return { tool, ...f };
  }

  it('walks the guard ladder: lead-only → status → plans exist → all lead-approved', async () => {
    const { tool } = makeTool({
      taskStatus: 'planning',
      plans: APPROVED_TWO,
    });
    expect(
      await tool.execute({ task_id: 7, summary: 's' }, identity('alex')),
    ).toContain("team lead's call");

    const wrongStatus = makeTool({ taskStatus: 'open' });
    expect(
      await wrongStatus.tool.execute(
        { task_id: 7, summary: 's' },
        identity('atlas'),
      ),
    ).toContain("'open'");

    const noPlans = makeTool({ taskStatus: 'planning', plans: [] });
    expect(
      await noPlans.tool.execute({ task_id: 7, summary: 's' }, identity('atlas')),
    ).toContain('No plans are attached');

    const pending = makeTool({
      taskStatus: 'planning',
      plans: [plan('alex', 'approved'), plan('riley', 'pending')],
    });
    expect(
      await pending.tool.execute({ task_id: 7, summary: 's' }, identity('atlas')),
    ).toContain("aren't lead-approved yet: riley");
  });

  it('flips via atomic transition and presents the full event', async () => {
    const presented: PlanProposalEvent[] = [];
    const { tool, board } = makeTool({
      taskStatus: 'planning',
      plans: APPROVED_TWO,
      presenter: {
        present: (e) => {
          presented.push(e);
          return Promise.resolve();
        },
      },
    });
    const out = await tool.execute(
      { task_id: 7, summary: 'the consolidated summary' },
      identity('atlas'),
    );
    expect(out).toContain('approval card posted');
    expect(board.transition).toHaveBeenCalledWith('T1', 7, 'planning', {
      status: 'awaiting_approval',
    });
    expect(presented).toHaveLength(1);
    expect(presented[0]).toMatchObject({
      team: 'T1',
      taskId: 7,
      title: 'Wire the API',
      summary: 'the consolidated summary',
      proposedBy: 'atlas',
      surfaceId: 'slack:T1:C42',
    });
    expect(presented[0].plans.map((p) => p.employee)).toEqual([
      'alex',
      'riley',
    ]);
  });

  it('re-propose: an awaiting_approval ticket skips the transition and just re-presents', async () => {
    const presented: PlanProposalEvent[] = [];
    const { tool, board } = makeTool({
      taskStatus: 'awaiting_approval',
      plans: APPROVED_TWO,
      presenter: {
        present: (e) => {
          presented.push(e);
          return Promise.resolve();
        },
      },
    });
    const out = await tool.execute(
      { task_id: 7, summary: 's' },
      identity('atlas'),
    );
    expect(out).toContain('approval card posted');
    expect(board.transition).not.toHaveBeenCalled();
    expect(presented).toHaveLength(1);
  });

  it('degrades to chat-words when no presenter is bound or present() throws', async () => {
    const unbound = makeTool({
      taskStatus: 'planning',
      plans: APPROVED_TWO,
    });
    const out1 = await unbound.tool.execute(
      { task_id: 7, summary: 's' },
      identity('atlas'),
    );
    expect(out1).toContain('No approval-card surface is bound');
    expect(out1).toContain('awaiting_approval');

    const throwing = makeTool({
      taskStatus: 'planning',
      plans: APPROVED_TWO,
      presenter: { present: () => Promise.reject(new Error('slack down')) },
    });
    const out2 = await throwing.tool.execute(
      { task_id: 7, summary: 's' },
      identity('atlas'),
    );
    expect(out2).toContain('FAILED (slack down)');
    expect(out2).toContain('walk Dennis through your summary');
  });
});
