import { makeEmployee } from '@harness/employees/employee.testing';
import type { Identity } from '../../domain/identity';
import type {
  EnsureReferenceResult,
  ReferenceLibraryService,
} from '../../workspaces/reference-library.service';
import { InvestigateTool } from './investigate.tool';

/**
 * The `investigate` tool: a read-only fact-grounding session on the INVESTIGATE engine recipe (the
 * execute engine, so the create-time engine pin matches), opened in the 'investigate' mode (never
 * 'plan'/'execute'), with low-friction workspace resolution (given → latest → create_workspace). Any
 * `references` are materialized in the shared host reference library (mounted into the session sandbox
 * at /refs); here we lock the tool's wiring with the session-open path + library mocked.
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
  /** The reference catalog `projects.list` returns (for the references path). */
  catalog?: Array<{ projectId: string; displayName: string; gitUrl: string }>;
  /** Make the reference library report a clone failure (transient/auth). */
  cloneFails?: boolean;
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
  const ensureReference = vi.fn(
    (_team: string, target: { projectId?: string; gitUrl?: string }) =>
      Promise.resolve<EnsureReferenceResult>(
        opts.cloneFails
          ? { ok: false, reason: 'clone-failed', detail: 'boom' }
          : {
              ok: true,
              slug: target.projectId ?? 'ref',
              mountPath: `/refs/${target.projectId ?? 'ref'}`,
              gitUrl: 'https://github.com/dennis/cubix-infra',
            },
      ),
  );
  const refs = {
    ensureReference,
    orientation: vi.fn(() => Promise.resolve('Top level: src')),
  };
  const alex = makeEmployee({ id: 'alex', name: 'Alex' });
  const employees = {
    byId: () => alex,
    fallbackOwner: () => alex,
    context: () => ({ team: 'local', roster: 'Alex' }),
  };
  const projects = { list: vi.fn(() => Promise.resolve(opts.catalog ?? [])) };
  const sessions = { update: vi.fn(() => Promise.resolve(undefined)) };
  const tool = new InvestigateTool(
    createSession as never,
    workspaces as never,
    refs as unknown as ReferenceLibraryService,
    employees as never,
    projects as never,
    sessions as never,
  );
  return {
    tool,
    openSession,
    workspaces,
    created,
    projects,
    sessions,
    ensureReference,
  };
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

  it('points at create_workspace when the bot has no workstation (no port-side cut anymore)', async () => {
    const { tool, openSession } = makeTool({ workspaces: [] });
    const out = await tool.execute({ question: 'where is X?' }, ctx);
    expect(openSession).not.toHaveBeenCalled();
    expect(out).toContain('create_workspace');
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

  const catalog = [
    {
      projectId: 'cubix-infra',
      displayName: 'Cubix Infra',
      gitUrl: 'https://github.com/dennis/cubix-infra',
    },
  ];

  it('materializes a resolved reference in the library (by projectId), records + notes it', async () => {
    const { tool, openSession, ensureReference, sessions } = makeTool({
      workspaces: [{ id: 'ws-001' }],
      catalog,
    });
    const out = await tool.execute(
      { question: 'how does cubix-infra do SSE?', references: ['cubix-infra'] },
      ctx,
    );
    expect(ensureReference).toHaveBeenCalledWith('T1', {
      projectId: 'cubix-infra',
    });
    expect(sessions.update).toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(out).toContain('Reading also');
    expect(out).toContain('cubix-infra');
  });

  it('buckets an unknown reference as not-registered (onboard_project), session still opens', async () => {
    const { tool, openSession } = makeTool({
      workspaces: [{ id: 'ws-001' }],
      catalog: [],
    });
    const out = await tool.execute({ question: 'q', references: ['nope'] }, ctx);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(out).toContain('onboard_project');
    expect(out).toMatch(/in the catalog/i);
  });

  it('buckets a failed reference clone distinctly (retry/token), session still opens', async () => {
    const { tool, openSession } = makeTool({
      workspaces: [{ id: 'ws-001' }],
      catalog,
      cloneFails: true,
    });
    const out = await tool.execute(
      { question: 'q', references: ['cubix-infra'] },
      ctx,
    );
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/couldn't clone cubix-infra/i);
    expect(out).toMatch(/retry/i);
    // A clone failure is NOT a registration miss.
    expect(out).not.toMatch(/in the catalog/i);
  });
});
