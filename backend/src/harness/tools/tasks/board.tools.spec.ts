import type { Identity } from '../../domain/identity';
import type { BoardTask } from '../../memory/board-store';
import type { PlanState } from '../../memory/plan-store';
import { STATUS_COLUMN_GUIDE } from '../../employees/persona.prompts';
import {
  AddBoardTaskTool,
  ClaimBoardTaskTool,
  ListBoardTool,
  UpdateBoardTaskTool,
} from './board.tools';

/**
 * The board tools' AUTHORITY matrix — gated in execute(), not the table: the team lead
 * creates/assigns/edits anything; a teammate files unassigned/self-assigned work, claims, and
 * completes/releases only their own. Store behavior (atomic claim, dep blocking) is covered by the
 * team-board int test; here the store is mocked.
 */

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: 7,
  project: 'proj',
  title: 'Wire the API',
  description: '',
  status: 'open',
  assignee: undefined,
  createdBy: 'sam',
  dependsOn: [],
  createdAt: '2026-06-11T00:00:00.000Z',
  updatedAt: '2026-06-11T00:00:00.000Z',
  ...overrides,
});

const identity = (selfAgent: string): { identity: Identity } => ({
  identity: {
    selfAgent,
    team: 'T1',
    project: 'proj',
    participants: ['dennis'],
    speaker: 'dennis',
    surface: 'chan',
    isChannel: true,
  },
});

function makeFakes() {
  const board = {
    create: vi.fn(async (t: Record<string, unknown>) =>
      task({
        assignee: (t.assignee as string) ?? undefined,
        dependsOn: (t.dependsOn as number[]) ?? [],
      }),
    ),
    claim: vi.fn(async () => task({ status: 'planning', assignee: 'alex' })),
    update: vi.fn(async (_t: string, _id: number, patch: Partial<BoardTask>) =>
      task(patch),
    ),
    get: vi.fn(async () => task()),
    list: vi.fn(async () => [task()]),
    blockersOf: vi.fn(async () => new Map<number, number[]>()),
  };
  const plans = {
    planStatesOf: vi.fn(async () => new Map<number, PlanState>()),
  };
  // Sam is the lead; alex/riley are teammates.
  const employees = {
    byId: (id: string) =>
      ['sam', 'alex', 'riley'].includes(id)
        ? { id, name: id, teamLead: id === 'sam' }
        : undefined,
  };
  return { board, plans, employees };
}

describe('board tools authority', () => {
  it('a teammate files unassigned or self-assigned tasks, but cross-assignment is refused', async () => {
    const { board, employees } = makeFakes();
    const tool = new AddBoardTaskTool(board as never, employees as never);

    await expect(
      tool.execute({ title: 'X' }, identity('alex')),
    ).resolves.toContain('Added board task');
    await expect(
      tool.execute({ title: 'X', assignee: 'alex' }, identity('alex')),
    ).resolves.toContain('Added board task');
    await expect(
      tool.execute({ title: 'X', assignee: 'riley' }, identity('alex')),
    ).resolves.toContain('Only the team lead assigns');
    expect(board.create).toHaveBeenCalledTimes(2);
  });

  it('the lead assigns to anyone; an unknown assignee is refused for everyone', async () => {
    const { board, employees } = makeFakes();
    const tool = new AddBoardTaskTool(board as never, employees as never);
    await expect(
      tool.execute({ title: 'X', assignee: 'riley' }, identity('sam')),
    ).resolves.toContain('Added board task');
    await expect(
      tool.execute({ title: 'X', assignee: 'nobody' }, identity('sam')),
    ).resolves.toContain("No teammate 'nobody'");
  });

  it('unknown dependency ids are surfaced, not silently dropped', async () => {
    const { board, employees } = makeFakes();
    board.create.mockResolvedValue({ unknownDeps: [41, 42] } as never);
    const tool = new AddBoardTaskTool(board as never, employees as never);
    await expect(
      tool.execute({ title: 'X', depends_on: [41, 42] }, identity('sam')),
    ).resolves.toContain('Unknown dependency id(s) #41, #42');
  });

  it('claim relays the store verdict: won, taken, blocked (with blocker ids), missing', async () => {
    const { board } = makeFakes();
    const tool = new ClaimBoardTaskTool(board as never);

    await expect(tool.execute({ id: 7 }, identity('alex'))).resolves.toContain(
      'Claimed board task #7',
    );

    board.claim.mockResolvedValue('taken' as never);
    board.get.mockResolvedValue(task({ assignee: 'riley' }));
    await expect(tool.execute({ id: 7 }, identity('alex'))).resolves.toContain(
      'assigned to riley',
    );

    board.claim.mockResolvedValue('blocked' as never);
    board.get.mockResolvedValue(task({ dependsOn: [3] }));
    board.blockersOf.mockResolvedValue(new Map([[7, [3]]]));
    await expect(tool.execute({ id: 7 }, identity('alex'))).resolves.toContain(
      'blocked by #3',
    );

    board.claim.mockResolvedValue('missing' as never);
    await expect(tool.execute({ id: 99 }, identity('alex'))).resolves.toContain(
      'No board task #99',
    );
  });

  it("a teammate completes or releases their OWN task — not someone else's, and no edits", async () => {
    const { board, employees } = makeFakes();
    const tool = new UpdateBoardTaskTool(board as never, employees as never);

    board.get.mockResolvedValue(
      task({ assignee: 'alex', status: 'planning' }),
    );
    await expect(
      tool.execute({ id: 7, status: 'done' }, identity('alex')),
    ).resolves.toContain('done');
    await expect(
      tool.execute({ id: 7, status: 'open' }, identity('alex')),
    ).resolves.toContain('released back to the board');
    // Release clears the assignee.
    expect(board.update).toHaveBeenLastCalledWith('T1', 7, {
      status: 'open',
      assignee: null,
    });

    await expect(
      tool.execute({ id: 7, status: 'done' }, identity('riley')),
    ).resolves.toContain("alex's — only they or the team lead");
    await expect(
      tool.execute({ id: 7, title: 'renamed' }, identity('alex')),
    ).resolves.toContain("the team lead's call");
    await expect(
      tool.execute({ id: 7, status: 'planning' }, identity('alex')),
    ).resolves.toContain('claim_board_task');
  });

  it("the approval seam: 'awaiting_approval' and 'approved' are both lead-only", async () => {
    const { board, employees } = makeFakes();
    const tool = new UpdateBoardTaskTool(board as never, employees as never);

    // A teammate can NOT post for approval — plans auto-attach; the lead proposes (propose_plan).
    board.get.mockResolvedValue(
      task({ assignee: 'alex', status: 'planning' }),
    );
    await expect(
      tool.execute({ id: 7, status: 'awaiting_approval' }, identity('alex')),
    ).resolves.toContain('@Sam');
    // …and cannot approve, even their own.
    board.get.mockResolvedValue(
      task({ assignee: 'alex', status: 'awaiting_approval' }),
    );
    await expect(
      tool.execute({ id: 7, status: 'approved' }, identity('alex')),
    ).resolves.toContain("the team lead's call");

    // The lead approves a proposed ticket…
    await expect(
      tool.execute({ id: 7, status: 'approved' }, identity('sam')),
    ).resolves.toContain('APPROVED');
    // …but not one that was never proposed.
    board.get.mockResolvedValue(
      task({ assignee: 'alex', status: 'planning' }),
    );
    await expect(
      tool.execute({ id: 7, status: 'approved' }, identity('sam')),
    ).resolves.toContain("not 'awaiting_approval'");

    // The lead's manual escape hatch still works.
    await expect(
      tool.execute({ id: 7, status: 'awaiting_approval' }, identity('sam')),
    ).resolves.toContain('posted for approval');
  });

  it("an assignee can't self-'done' APPROVED or in-review work — that acceptance is the lead's (Dennis's call)", async () => {
    const { board, employees } = makeFakes();
    const tool = new UpdateBoardTaskTool(board as never, employees as never);

    // Approved work: the assignee can't complete it themselves.
    board.get.mockResolvedValue(task({ assignee: 'alex', status: 'approved' }));
    await expect(
      tool.execute({ id: 7, status: 'done' }, identity('alex')),
    ).resolves.toContain("team lead's call");

    // In-review work: same — they keep addressing feedback; the lead closes it.
    board.get.mockResolvedValue(
      task({ assignee: 'alex', status: 'in_review' }),
    );
    await expect(
      tool.execute({ id: 7, status: 'done' }, identity('alex')),
    ).resolves.toContain('Dennis accepts');

    // The lead records Dennis's acceptance.
    await expect(
      tool.execute({ id: 7, status: 'done' }, identity('sam')),
    ).resolves.toContain('done');
  });

  it('the lead reassigns, reopens, and edits anything', async () => {
    const { board, employees } = makeFakes();
    const tool = new UpdateBoardTaskTool(board as never, employees as never);
    board.get.mockResolvedValue(task({ assignee: 'alex', status: 'done' }));
    await expect(
      tool.execute(
        { id: 7, status: 'open', assignee: 'riley', title: 'Re-scoped' },
        identity('sam'),
      ),
    ).resolves.toContain('Updated board task #7');
    expect(board.update).toHaveBeenCalledWith('T1', 7, {
      status: 'open',
      assignee: 'riley',
      title: 'Re-scoped',
    });
  });

  it('list_board renders the live board with assignee, status, deps, and BLOCKED markers', async () => {
    const { board, plans } = makeFakes();
    board.list.mockResolvedValue([
      task({ id: 1, title: 'Contract', status: 'done', assignee: 'maya' }),
      task({
        id: 2,
        title: 'Backend',
        status: 'planning',
        assignee: 'alex',
      }),
      task({ id: 3, title: 'Frontend', dependsOn: [2] }),
    ]);
    board.blockersOf.mockResolvedValue(new Map([[3, [2]]]));
    // empty planStates → no plan tags rendered
    const tool = new ListBoardTool(board as never, plans as never);
    const out = await tool.execute({}, identity('riley'));
    expect(out).not.toContain('Contract'); // done rows drop from the default live view
    expect(out).toContain('[#2] Backend (→ alex, planning)');
    expect(out).toContain(
      '[#3] Frontend (unassigned, open) after #2 — BLOCKED by #2',
    );
  });

  it('list_board includes plan: tags when planStatesOf returns data, omits tag for absent tasks', async () => {
    const { board, plans } = makeFakes();
    board.list.mockResolvedValue([
      task({ id: 1, title: 'Alpha', status: 'planning', assignee: 'alex' }),
      task({ id: 2, title: 'Beta', status: 'awaiting_approval', assignee: 'riley' }),
      task({ id: 3, title: 'Gamma', status: 'open' }),
    ]);
    board.blockersOf.mockResolvedValue(new Map());
    plans.planStatesOf.mockResolvedValue(
      new Map<number, PlanState>([
        [2, 'pending_review'],
        [3, 'lead_approved'],
      ]),
    );
    const tool = new ListBoardTool(board as never, plans as never);
    const out = await tool.execute({}, identity('riley'));
    // task 1: no plan state → no tag
    expect(out).toContain('[#1] Alpha (→ alex, planning)');
    // task 2: pending_review
    expect(out).toContain('[#2] Beta (→ riley, awaiting_approval, plan: pending_review)');
    // task 3: lead_approved
    expect(out).toContain('[#3] Gamma (unassigned, open, plan: lead_approved)');
  });

  it('STATUS_COLUMN_GUIDE contains the canonical status→column mapping and lifecycle semantics', () => {
    // Each status → column pair (the eight-status lifecycle)
    expect(STATUS_COLUMN_GUIDE).toContain('open → "Backlog"');
    expect(STATUS_COLUMN_GUIDE).toContain('planning → "Planning"');
    expect(STATUS_COLUMN_GUIDE).toContain('awaiting_approval → "Awaiting Approval"');
    expect(STATUS_COLUMN_GUIDE).toContain('approved → "Approved"');
    expect(STATUS_COLUMN_GUIDE).toContain('executing → "Executing"');
    expect(STATUS_COLUMN_GUIDE).toContain('self_review → "Self-Review"');
    expect(STATUS_COLUMN_GUIDE).toContain('in_review → "In Review"');
    expect(STATUS_COLUMN_GUIDE).toContain('done → "Done"');
    // No bogus columns
    expect(STATUS_COLUMN_GUIDE).toContain('STATUS and nothing else');
    expect(STATUS_COLUMN_GUIDE).toContain('no "in queue"');
    // Lifecycle semantics
    expect(STATUS_COLUMN_GUIDE).toContain('eight statuses');
    expect(STATUS_COLUMN_GUIDE).toContain('the automated PR/code self-review');
    // Plan legend
    expect(STATUS_COLUMN_GUIDE).toContain('pending_review');
    expect(STATUS_COLUMN_GUIDE).toContain('lead_approved');
    expect(STATUS_COLUMN_GUIDE).toContain('no tag = no plan attached yet');
  });

  it('ListBoardTool.description includes STATUS_COLUMN_GUIDE', () => {
    const { board, plans } = makeFakes();
    const tool = new ListBoardTool(board as never, plans as never);
    expect(tool.description).toContain(STATUS_COLUMN_GUIDE);
  });
});

describe('UpdateBoardTaskTool — description-change notification', () => {
  /** Surface id that looks like a Slack coordinate so the adapter can parse it. */
  const slackIdentity = (selfAgent: string): { identity: Identity } => ({
    identity: {
      selfAgent,
      team: 'T1',
      project: 'proj',
      participants: ['dennis'],
      speaker: 'dennis',
      surface: 'slack:T1:C99',
      isChannel: true,
    },
  });

  const makeNotifierFakes = () => {
    const { board, employees } = makeFakes();
    const notifier = { notifyDescriptionChange: vi.fn(async () => {}) };
    return { board, employees, notifier };
  };

  it.each([
    'approved',
    'executing',
    'self_review',
    'in_review',
  ] as const)(
    'calls notifyDescriptionChange when description changes on a %s ticket',
    async (status) => {
      const { board, employees, notifier } = makeNotifierFakes();
      board.get.mockResolvedValue(
        task({ status, description: 'old text', assignee: 'alex' }),
      );
      board.update.mockResolvedValue(
        task({ status, description: 'new text', assignee: 'alex' }),
      );
      const tool = new UpdateBoardTaskTool(
        board as never,
        employees as never,
        notifier as never,
      );
      await tool.execute(
        { id: 7, description: 'new text' },
        slackIdentity('sam'),
      );
      expect(notifier.notifyDescriptionChange).toHaveBeenCalledWith(
        expect.objectContaining({
          team: 'T1',
          taskId: 7,
          title: 'Wire the API',
          changedBy: 'sam',
          oldDescription: 'old text',
          newDescription: 'new text',
          surfaceId: 'slack:T1:C99',
        }),
      );
    },
  );

  it.each([
    'open',
    'planning',
    'awaiting_approval',
    'done',
  ] as const)(
    'does NOT notify when description changes on a %s ticket',
    async (status) => {
      const { board, employees, notifier } = makeNotifierFakes();
      board.get.mockResolvedValue(
        task({ status, description: 'old', assignee: 'alex' }),
      );
      board.update.mockResolvedValue(task({ status, description: 'new' }));
      const tool = new UpdateBoardTaskTool(
        board as never,
        employees as never,
        notifier as never,
      );
      // non-lead can't change description, so use sam for all statuses
      await tool.execute({ id: 7, description: 'new' }, slackIdentity('sam'));
      expect(notifier.notifyDescriptionChange).not.toHaveBeenCalled();
    },
  );

  it('does NOT notify when the description text is unchanged (no-op write)', async () => {
    const { board, employees, notifier } = makeNotifierFakes();
    board.get.mockResolvedValue(
      task({ status: 'executing', description: 'same text' }),
    );
    board.update.mockResolvedValue(
      task({ status: 'executing', description: 'same text' }),
    );
    const tool = new UpdateBoardTaskTool(
      board as never,
      employees as never,
      notifier as never,
    );
    await tool.execute({ id: 7, description: 'same text' }, slackIdentity('sam'));
    expect(notifier.notifyDescriptionChange).not.toHaveBeenCalled();
  });

  it('does NOT notify on a status-only update (no description provided)', async () => {
    const { board, employees, notifier } = makeNotifierFakes();
    board.get.mockResolvedValue(
      task({ status: 'executing', description: 'some text', assignee: 'alex' }),
    );
    board.update.mockResolvedValue(task({ status: 'done' }));
    const tool = new UpdateBoardTaskTool(
      board as never,
      employees as never,
      notifier as never,
    );
    await tool.execute({ id: 7, status: 'done' }, slackIdentity('sam'));
    expect(notifier.notifyDescriptionChange).not.toHaveBeenCalled();
  });

  it('does NOT notify on a title-only update', async () => {
    const { board, employees, notifier } = makeNotifierFakes();
    board.get.mockResolvedValue(
      task({ status: 'approved', description: 'some text' }),
    );
    board.update.mockResolvedValue(task({ status: 'approved', title: 'New title' }));
    const tool = new UpdateBoardTaskTool(
      board as never,
      employees as never,
      notifier as never,
    );
    await tool.execute({ id: 7, title: 'New title' }, slackIdentity('sam'));
    expect(notifier.notifyDescriptionChange).not.toHaveBeenCalled();
  });

  it('a throwing notifier does NOT fail the tool — error is swallowed', async () => {
    const { board, employees, notifier } = makeNotifierFakes();
    notifier.notifyDescriptionChange.mockRejectedValue(
      new Error('non-Slack room'),
    );
    board.get.mockResolvedValue(
      task({ status: 'approved', description: 'old', assignee: 'alex' }),
    );
    board.update.mockResolvedValue(
      task({ status: 'approved', description: 'new' }),
    );
    const tool = new UpdateBoardTaskTool(
      board as never,
      employees as never,
      notifier as never,
    );
    // Should resolve (not throw) despite the notifier rejecting.
    await expect(
      tool.execute({ id: 7, description: 'new' }, slackIdentity('sam')),
    ).resolves.not.toThrow();
  });

  it('no notifier bound (TUI/headless) silently no-ops', async () => {
    const { board, employees } = makeFakes();
    board.get.mockResolvedValue(
      task({ status: 'approved', description: 'old' }),
    );
    board.update.mockResolvedValue(
      task({ status: 'approved', description: 'new' }),
    );
    // No notifier injected (undefined).
    const tool = new UpdateBoardTaskTool(board as never, employees as never);
    await expect(
      tool.execute({ id: 7, description: 'new' }, slackIdentity('sam')),
    ).resolves.not.toThrow();
  });
});
