import { makeEmployee } from '@harness/employees/employee.testing';
import type { Identity } from '../../domain/identity';
import { localGitProvider } from '../../workspaces/workspace-git.test-util';
import { InvestigateTool } from './investigate.tool';

/**
 * The `investigate` tool: a read-only fact-grounding session on the INVESTIGATE engine recipe (the
 * execute engine, so the create-time engine pin matches), opened in the 'investigate' mode (never
 * 'plan'/'execute'), with low-friction workspace resolution (given → latest → auto-create). The
 * engine's read-only enforcement for the mode is covered at the engine seam; here we lock the tool's
 * wiring with the session-open path mocked.
 */

const ctx: { identity: Identity } = {
  identity: {
    selfAgent: 'alex',
    team: 'T1',
    project: 'proj',
    participants: ['dennis'],
    speaker: 'dennis',
    surface: 'chan',
    isChannel: true,
  },
};

function makeTool(opts: {
  workspaces?: { id: string }[];
  getById?: (id: string) => { id: string } | undefined;
}) {
  const openSession = vi.fn((_opts: Record<string, unknown>) =>
    Promise.resolve({ sessionId: 'sess-001' }),
  );
  const createSession = { openSession };
  const created: Record<string, unknown>[] = [];
  const workspaces = {
    get: opts.getById ?? ((id: string) => ({ id, path: '/tmp/ws' })),
    list: vi.fn(() => opts.workspaces ?? []),
    create: vi.fn((input: Record<string, unknown>) => {
      created.push(input);
      return Promise.resolve({
        workspace: { id: 'ws-new', branch: 'investigate' },
      });
    }),
  };
  const alex = makeEmployee({ id: 'alex', name: 'Alex' });
  const employees = {
    byId: () => alex,
    fallbackOwner: () => alex,
    context: () => ({ team: 'local', roster: 'Alex' }),
  };
  const projects = { list: vi.fn(() => Promise.resolve([])) };
  const sessions = { update: vi.fn(() => Promise.resolve(undefined)) };
  const tool = new InvestigateTool(
    createSession as never,
    workspaces as never,
    // create / ensureReferenceClone route through the provider; resolve to the same mock.
    localGitProvider(workspaces as never),
    employees as never,
    projects as never,
    sessions as never,
  );
  return { tool, openSession, workspaces, created, projects, sessions };
}

describe('investigate', () => {
  it('opens a read-only investigate session on the investigate engine, reusing the latest workspace', async () => {
    const { tool, openSession, workspaces } = makeTool({
      workspaces: [{ id: 'ws-old' }, { id: 'ws-001' }],
    });
    const out = await tool.execute(
      { question: 'how does the gate work?' },
      ctx,
    );
    expect(workspaces.create).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledTimes(1);
    const call = openSession.mock.calls[0][0];
    expect(call.mode).toBe('investigate');
    expect(call.workspaceId).toBe('ws-001'); // the latest
    expect(call.engine).toBe('claude'); // investigate keeps the execute engine (model-only override)
    expect(call.openingTask).toContain('READ-ONLY');
    expect(call.openingTask).toContain('how does the gate work?');
    expect(out).toContain('sess-001');
  });

  it('auto-opens a fresh workspace when the bot has none', async () => {
    const { tool, openSession, workspaces, created } = makeTool({
      workspaces: [],
    });
    const out = await tool.execute({ question: 'where is X?' }, ctx);
    expect(workspaces.create).toHaveBeenCalledTimes(1);
    expect(created[0]).toMatchObject({
      ownerBot: 'alex',
      team: 'T1',
      project: 'proj',
    });
    expect(openSession.mock.calls[0][0].workspaceId).toBe('ws-new');
    expect(out).toContain('fresh workspace');
  });

  it('errors (and opens nothing) on an unknown explicit workspaceId', async () => {
    const { tool, openSession } = makeTool({ getById: () => undefined });
    const out = await tool.execute({ question: 'q', workspaceId: 'nope' }, ctx);
    expect(out).toContain('No workspace "nope"');
    expect(openSession).not.toHaveBeenCalled();
  });

  it('always requires the epistemic-output trailer, even with no intent', async () => {
    const { tool, openSession } = makeTool({ workspaces: [{ id: 'ws-001' }] });
    await tool.execute({ question: 'does a Slack adapter exist?' }, ctx);
    const task = openSession.mock.calls[0][0].openingTask as string;
    expect(task).toContain('Confidence: high | medium | low');
    expect(task).toContain("Couldn't verify:");
    expect(task).not.toContain('FOCUS:'); // no intent → no emphasis line
  });

  it('threads board_task_id to openSession as boardTaskId (the grounding artifact)', async () => {
    const { tool, openSession } = makeTool({ workspaces: [{ id: 'ws-001' }] });
    await tool.execute(
      { question: 'how does X sit in the repo?', board_task_id: 42 },
      ctx,
    );
    expect(openSession.mock.calls[0][0].boardTaskId).toBe(42);
  });

  it('omits boardTaskId when board_task_id is not given', async () => {
    const { tool, openSession } = makeTool({ workspaces: [{ id: 'ws-001' }] });
    await tool.execute({ question: 'q' }, ctx);
    expect(openSession.mock.calls[0][0].boardTaskId).toBeUndefined();
  });

  it('injects a distinct emphasis line per intent', async () => {
    const cases: Array<['trace' | 'debug' | 'review', string]> = [
      ['trace', 'walk the exact path'],
      ['debug', 'check whether the premise is even true'],
      ['review', 'trade-offs'],
    ];
    for (const [intent, needle] of cases) {
      const { tool, openSession } = makeTool({ workspaces: [{ id: 'ws-001' }] });
      await tool.execute({ question: 'q', intent }, ctx);
      const task = openSession.mock.calls[0][0].openingTask as string;
      expect(task).toContain('FOCUS:');
      expect(task.toLowerCase()).toContain(needle);
      // the required trailer rides along regardless of intent
      expect(task).toContain('Confidence: high | medium | low');
    }
  });
});
