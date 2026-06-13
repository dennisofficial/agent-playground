import type { Identity } from '../../domain/identity';
import type { TaskPlan } from '../../memory/plan-store';
import type { TicketNote } from '../../memory/ticket-note-store';
import { AddNoteTool, GetTicketTool } from './ticket.tools';

const ctx: { identity: Identity } = {
  identity: {
    selfAgent: 'nora',
    team: 'T1',
    project: 'proj',
    participants: ['dennis'],
    speaker: 'dennis',
    surface: 'chan',
    isChannel: true,
  },
};

const TASK = {
  id: 7,
  project: 'proj',
  title: 'Wire the API',
  description: 'The full description.',
  status: 'in_progress' as const,
  assignee: 'alex',
  createdBy: 'sam',
  dependsOn: [3],
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T00:00:00.000Z',
};

const plan = (employee: string, planMd: string): TaskPlan => ({
  id: 1,
  taskId: 7,
  employee,
  planMd,
  leadStatus: 'pending',
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T01:00:00.000Z',
});

const note = (id: number, body: string): TicketNote => ({
  id,
  taskId: 7,
  author: 'nora',
  body,
  createdAt: '2026-06-12T02:00:00.000Z',
});

function makeFakes(opts: {
  plans?: TaskPlan[];
  notes?: TicketNote[];
  total?: number;
  oneNote?: TicketNote;
  onePlan?: TaskPlan;
}) {
  const board = { get: vi.fn(() => Promise.resolve(TASK)) };
  const plans = {
    listForTask: vi.fn(() => Promise.resolve(opts.plans ?? [])),
    get: vi.fn(() => Promise.resolve(opts.onePlan)),
  };
  const notes = {
    listForTask: vi.fn(() =>
      Promise.resolve({
        notes: opts.notes ?? [],
        total: opts.total ?? opts.notes?.length ?? 0,
      }),
    ),
    get: vi.fn(() => Promise.resolve(opts.oneNote)),
    add: vi.fn((_t: string, taskId: number, author: string, body: string) =>
      Promise.resolve(note(9, body) && { ...note(9, body), taskId, author }),
    ),
  };
  return { board, plans, notes };
}

describe('get_ticket', () => {
  it('overview: header, description, plan snippets with drill-down hints, note snippets', async () => {
    const longPlan = `# Plan\n${'step then more detail\n'.repeat(60)}`;
    const f = makeFakes({
      plans: [plan('alex', longPlan), plan('riley', 'short plan')],
      notes: [note(4, 'a short note'), note(3, 'x'.repeat(900))],
      total: 2,
    });
    const tool = new GetTicketTool(
      f.board as never,
      f.plans as never,
      f.notes as never,
    );
    const out = await tool.execute({ id: 7 }, ctx);
    expect(out).toContain('#7 — Wire the API (→ alex, in_progress, after #3)');
    expect(out).toContain('The full description.');
    expect(out).toContain("### alex's plan [lead: pending]");
    expect(out).toContain(`get_ticket(7, plan_of: 'alex') for the full plan`);
    expect(out).toMatch(
      /### riley's plan \[lead: pending\] \(updated [^)]+\)\nshort plan/,
    );
    expect(out).not.toContain('short plan\n…('); // short plan isn't truncated
    expect(out).toContain('[note #4] nora');
    expect(out).toContain('get_ticket(7, note: 3)'); // long note got a drill-down hint
  });

  it('plan_of: full plan text, paginated top-down', async () => {
    const big = 'line of plan text\n'.repeat(500); // ~9000 chars → 3 pages
    const f = makeFakes({ onePlan: plan('alex', big) });
    const tool = new GetTicketTool(
      f.board as never,
      f.plans as never,
      f.notes as never,
    );
    const p1 = await tool.execute({ id: 7, plan_of: 'alex' }, ctx);
    expect(p1).toContain("alex's plan on #7 [lead: pending]");
    expect(p1).toContain('page 1/3');
    expect(p1).toContain("get_ticket(7, plan_of: 'alex', page: 2)");
    const p3 = await tool.execute({ id: 7, plan_of: 'alex', page: 3 }, ctx);
    expect(p3).toContain('page 3/3');
    expect(p3).not.toContain('page: 4');

    const missing = makeFakes({ onePlan: undefined });
    const tool2 = new GetTicketTool(
      missing.board as never,
      missing.plans as never,
      missing.notes as never,
    );
    expect(await tool2.execute({ id: 7, plan_of: 'maya' }, ctx)).toContain(
      "No plan by 'maya'",
    );
  });

  it('note: one full note by id', async () => {
    const f = makeFakes({ oneNote: note(4, 'the full research write-up') });
    const tool = new GetTicketTool(
      f.board as never,
      f.plans as never,
      f.notes as never,
    );
    const out = await tool.execute({ id: 7, note: 4 }, ctx);
    expect(out).toContain('Note #4 on #7 by nora');
    expect(out).toContain('the full research write-up');
  });
});

describe('add_note', () => {
  it('validates the task and stamps the caller as author', async () => {
    const f = makeFakes({});
    const tool = new AddNoteTool(f.board as never, f.notes as never);
    const out = await tool.execute(
      { task_id: 7, body: 'research findings' },
      ctx,
    );
    expect(out).toContain('added to ticket #7');
    expect(f.notes.add).toHaveBeenCalledWith(
      'T1',
      7,
      'nora',
      'research findings',
    );

    f.board.get.mockResolvedValue(undefined as never);
    expect(await tool.execute({ task_id: 99, body: 'x' }, ctx)).toContain(
      'No board task #99',
    );
  });
});
