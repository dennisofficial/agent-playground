import { CheckPipelineTool } from './pipeline.tools';
import type { HarnessToolContext } from '../tool.types';

/**
 * check_pipeline — the orchestrator's READ-ONLY window into a running pipeline's active stage
 * session. Lead-only (stage sessions are owned by synthetic phase-config roles, invisible to the
 * rest of the roster); resolves the run, labels which section/phase it's in, and surfaces the live
 * stage session's progress (or last report once idle). Graceful refusals for non-leads, an unknown
 * task, no active stage, and a closed run. Never mutates anything.
 */

const ctx = (selfAgent = 'atlas') =>
  ({
    identity: { selfAgent, team: 'T1', project: 'proj', surface: 'chan' },
  }) as unknown as HarnessToolContext;

/** A minimal employee stub — `teamLead` gates the tool; the engine builders feed the tier display. */
function mkBot(id: string, opts: { teamLead?: boolean; name?: string } = {}) {
  const spec = () => ({ model: 'claude-sonnet-4-6', effort: undefined });
  return {
    id,
    name: opts.name ?? id,
    teamLead: opts.teamLead ?? false,
    planEngine: spec,
    executeEngine: spec,
    investigateEngine: spec,
  };
}

const ROSTER: Record<string, ReturnType<typeof mkBot>> = {
  atlas: mkBot('atlas', { teamLead: true, name: 'Atlas' }),
  bob: mkBot('bob'),
  phase_backend: mkBot('phase_backend'),
};

interface Fixtures {
  run?: unknown;
  sections?: unknown[];
  activeSection?: unknown;
  phaseRows?: unknown[];
  activePhase?: unknown;
  coding?: unknown;
  session?: unknown;
  activity?: string;
  transcript?: string;
  task?: unknown;
}

function makeTool(f: Fixtures) {
  const runs = { getByTask: vi.fn(() => Promise.resolve(f.run)) };
  const sections = {
    listForRun: vi.fn(() => Promise.resolve(f.sections ?? [])),
    activeSection: vi.fn(() => Promise.resolve(f.activeSection)),
  };
  const phases = {
    listForSection: vi.fn(() => Promise.resolve(f.phaseRows ?? [])),
    activePhase: vi.fn(() => Promise.resolve(f.activePhase)),
  };
  const coding = {
    activeCodingSession: vi.fn(() => Promise.resolve(f.coding)),
  };
  const sessionsReg = { get: vi.fn(() => Promise.resolve(f.session)) };
  const sessionRunner = {
    getSessionActivity: vi.fn(() => Promise.resolve(f.activity ?? 'working…')),
    searchTranscript: vi.fn(() => Promise.resolve(f.transcript ?? '(transcript)')),
  };
  const employees = {
    byId: vi.fn((id: string) => ROSTER[id]),
    context: vi.fn(() => ({})),
    fallbackOwner: vi.fn(() => ROSTER.atlas),
  };
  const board = { get: vi.fn(() => Promise.resolve(f.task)) };
  const tool = new CheckPipelineTool(
    runs as never,
    sections as never,
    phases as never,
    coding as never,
    sessionsReg as never,
    sessionRunner as never,
    employees as never,
    board as never,
  );
  return { tool, runs, sessionsReg, sessionRunner };
}

const buildingRun = {
  id: 'run-1',
  team: 'T1',
  taskId: 5,
  kind: 'feature',
  status: 'running',
  sessionId: 'sess-9',
};

const buildingFixtures: Fixtures = {
  run: buildingRun,
  task: { title: 'Add OAuth' },
  sections: [
    { id: 'sec-1', name: 'backend', phaseRole: 'phase_backend', status: 'building' },
    { id: 'sec-2', name: 'frontend', phaseRole: 'phase_frontend', status: 'pending' },
  ],
  activeSection: {
    id: 'sec-1',
    name: 'backend',
    phaseRole: 'phase_backend',
    status: 'building',
  },
  phaseRows: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
  activePhase: { id: 'p2' },
  coding: { status: 'building' },
  session: {
    id: 'sess-9',
    ownerBot: 'phase_backend',
    status: 'running',
    mode: 'execute',
    engine: 'claude',
    turns: 3,
  },
  activity: 'thinking: wiring the controller\n→ called edit_file (auth.controller.ts)',
};

describe('check_pipeline', () => {
  it('refuses a non-lead caller and reads nothing', async () => {
    const { tool, runs } = makeTool(buildingFixtures);
    const out = await tool.execute({ board_task_id: 5 }, ctx('bob'));
    expect(out).toContain("team lead's call");
    expect(runs.getByTask).not.toHaveBeenCalled();
  });

  it('returns the active stage progress for a building feature run', async () => {
    const { tool, sessionRunner } = makeTool(buildingFixtures);
    const out = await tool.execute({ board_task_id: 5 }, ctx());
    expect(out).toContain('Pipeline for #5 "Add OAuth" [running]');
    expect(out).toContain("section 1/2 'backend' (phase_backend) [building]");
    expect(out).toContain('building phase 2/3 (coding session building)');
    expect(out).toContain('Stage session sess-9 [running]');
    expect(out).toContain('execute on claude-sonnet-4-6');
    expect(out).toContain('Progress so far:');
    expect(out).toContain('wiring the controller');
    expect(sessionRunner.getSessionActivity).toHaveBeenCalledWith('sess-9');
  });

  it('pages the stage transcript when given a query (no glance read)', async () => {
    const { tool, sessionRunner } = makeTool({
      ...buildingFixtures,
      transcript: '2 of 9 lines match "controller"',
    });
    const out = await tool.execute(
      { board_task_id: 5, query: 'controller' },
      ctx(),
    );
    expect(sessionRunner.searchTranscript).toHaveBeenCalledWith('sess-9', {
      query: 'controller',
      page: undefined,
    });
    expect(sessionRunner.getSessionActivity).not.toHaveBeenCalled();
    expect(out).toContain('2 of 9 lines match');
  });

  it('reports the plan gate when a section is paused for approval', async () => {
    const { tool } = makeTool({
      run: { ...buildingRun, planningSubstep: 'gate' },
      sections: [
        { id: 'sec-1', name: 'backend', phaseRole: 'phase_backend', status: 'planning' },
      ],
      activeSection: {
        id: 'sec-1',
        name: 'backend',
        phaseRole: 'phase_backend',
        status: 'planning',
      },
      session: {
        id: 'sess-9',
        ownerBot: 'phase_backend',
        status: 'idle',
        mode: 'plan',
        engine: 'claude',
        turns: 1,
        lastReport: 'Plan: add the OAuth controller…',
      },
    });
    const out = await tool.execute({ board_task_id: 5 }, ctx());
    expect(out).toContain('PAUSED at plan gate (your approval)');
    expect(out).toContain('Last report: Plan: add the OAuth controller…');
  });

  it('gives a graceful message for an unknown task', async () => {
    const { tool } = makeTool({ run: undefined });
    const out = await tool.execute({ board_task_id: 99 }, ctx());
    expect(out).toContain('No pipeline run for #99');
  });

  it('gives a graceful message when there is no active stage session', async () => {
    const { tool, sessionsReg } = makeTool({
      run: { ...buildingRun, sessionId: undefined },
      sections: buildingFixtures.sections,
      activeSection: buildingFixtures.activeSection,
      phaseRows: buildingFixtures.phaseRows,
      activePhase: buildingFixtures.activePhase,
      coding: buildingFixtures.coding,
    });
    const out = await tool.execute({ board_task_id: 5 }, ctx());
    expect(out).toContain('No active stage session');
    expect(sessionsReg.get).not.toHaveBeenCalled();
  });

  it('reports a closed (done) run with its final report', async () => {
    const { tool } = makeTool({
      run: { ...buildingRun, status: 'done', sessionId: 'sess-9' },
      sections: buildingFixtures.sections,
      activeSection: undefined, // all sections shipped
      session: {
        id: 'sess-9',
        ownerBot: 'phase_backend',
        status: 'closed',
        mode: 'execute',
        engine: 'claude',
        turns: 6,
        lastReport: 'Shipped PR #42',
      },
    });
    const out = await tool.execute({ board_task_id: 5 }, ctx());
    expect(out).toContain('all sections shipped');
    expect(out).toContain('Closed. Final report: Shipped PR #42');
  });
});
