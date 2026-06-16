import { deepResearchCapability } from '../employees/capabilities/deep-research.capability';
import type { EmployeeContext } from '../employees/employee-context';
import type { EmployeeDefinition } from '../employees/employee.types';
import { makeEmployee } from '../employees/employee.testing';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import { EXECUTE_CODEX } from '../engines/engine-presets';
import type { CreateSessionTool } from './sessions/session.tools';
import type { WorktreeService } from '../worktrees/worktree.service';
import { EngineToolFactory } from './engine-tool.factory';

/**
 * The capability tool seam: a tool-triggered capability becomes a bound chat tool that opens a
 * session via CreateSessionTool.openSession (the shared path), with the engine from its EngineSpec.
 */

const CTX: EmployeeContext = { team: 'local', roster: 'Nora — researcher' };

// A Nora-like employee whose deep_research runs on Codex.
const nora = (): EmployeeDefinition => ({
  ...makeEmployee({
    id: 'nora',
    name: 'Nora',
    engine: EWorkerEngineName.CODEX,
  }),
  capabilities: () => [
    deepResearchCapability(() => ({
      ...EXECUTE_CODEX,
      systemPrompt: 'research worker',
    })),
  ],
});

const config = {
  configurable: {
    identity: {
      selfAgent: 'nora',
      team: 'local',
      project: 'p',
      surface: 'dev:root',
    },
  },
};

function build(opts: { worktrees?: string[] } = {}) {
  const opened: Array<Record<string, unknown>> = [];
  const createSession = {
    openSession: async (o: Record<string, unknown>) => {
      opened.push(o);
      return { sessionId: 'sess-research-1' };
    },
  } as unknown as CreateSessionTool;
  const worktrees = {
    get: (id: string) =>
      (opts.worktrees ?? []).includes(id) ? { id } : undefined,
    list: () => (opts.worktrees ?? []).map((id) => ({ id })),
  } as unknown as WorktreeService;
  return {
    factory: new EngineToolFactory(createSession, worktrees),
    opened,
  };
}

describe('EngineToolFactory', () => {
  it('binds a tool per tool-capability', () => {
    const { factory } = build({ worktrees: ['wt-1'] });
    const { tools } = factory.buildTools(nora(), CTX);
    expect(tools.map((t) => t.name)).toEqual(['deep_research']);
  });

  it('opens a session on the capability spec engine, reusing a given worktree', async () => {
    const { factory, opened } = build({ worktrees: ['wt-1'] });
    const { tools } = factory.buildTools(nora(), CTX);
    const out = await (
      tools[0] as { invoke: (a: unknown, c: unknown) => Promise<string> }
    ).invoke({ question: 'How does X price?', worktreeId: 'wt-1' }, config);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      worktreeId: 'wt-1',
      mode: 'plan',
      engine: EWorkerEngineName.CODEX,
      openingTask: 'How does X price?',
    });
    expect(out).toContain('deep_research session sess-research-1');
  });

  it('falls back to the bot’s latest worktree when none is given', async () => {
    const { factory, opened } = build({ worktrees: ['wt-1', 'wt-2'] });
    const { tools } = factory.buildTools(nora(), CTX);
    await (
      tools[0] as { invoke: (a: unknown, c: unknown) => Promise<string> }
    ).invoke({ question: 'research this' }, config);
    expect(opened[0]).toMatchObject({ worktreeId: 'wt-2' }); // latest
  });

  it('nudges to create a worktree when the bot has none', async () => {
    const { factory, opened } = build({ worktrees: [] });
    const { tools } = factory.buildTools(nora(), CTX);
    const out = await (
      tools[0] as { invoke: (a: unknown, c: unknown) => Promise<string> }
    ).invoke({ question: 'research this' }, config);
    expect(opened).toHaveLength(0);
    expect(out).toContain('create_worktree');
  });

  it('returns no tools for an employee with no tool-capabilities', () => {
    const { factory } = build();
    const { tools } = factory.buildTools(makeEmployee({ id: 'alex' }), CTX);
    expect(tools).toHaveLength(0);
  });
});
