import type { Identity } from '../../domain/identity';
import type { BoardTask } from '../../memory/board-store';
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
  // Sam is the lead; alex/riley are teammates.
  const employees = {
    byId: (id: string) =>
      ['sam', 'alex', 'riley'].includes(id)
        ? { id, name: id, teamLead: id === 'sam' }
        : undefined,
  };
  return { board, employees };
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
    const { board } = makeFakes();
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
    const tool = new ListBoardTool(board as never);
    const out = await tool.execute({}, identity('riley'));
    expect(out).not.toContain('Contract'); // done rows drop from the default live view
    expect(out).toContain('[#2] Backend (→ alex, planning)');
    expect(out).toContain(
      '[#3] Frontend (unassigned, open) after #2 — BLOCKED by #2',
    );
  });
});
