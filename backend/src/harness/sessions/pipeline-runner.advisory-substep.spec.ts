import { describe, expect, it, vi } from 'vitest';
import { PipelineRunnerService } from './pipeline-runner.service';
import {
  FakeCodingStore,
  FakeNoteStore,
  FakePhaseStore,
  FakeReviewStore,
  FakeRunStore,
  FakeSectionStore,
  type Row,
} from './pipeline-runner.test-fakes';

/**
 * The 'advisory' planningSubstep (Phase 3a): the one-shot codex_advisory self-review runs INSIDE the
 * plan turn (the PlanFinished lifecycle hook), so by the time the plan reports the advisory is done.
 * The runner stamps 'advisory' as the transient post-advisory / pre-gate marker, then clears it to
 * 'gate' at the pause. A crash in that window re-plans on boot (reopenCurrentStep treats 'advisory'
 * like 'drafting'), so the section never gets stuck half-gated.
 */

function build() {
  const runs = new FakeRunStore();
  const sectionStore = new FakeSectionStore();
  const phaseStore = new FakePhaseStore();
  const codingStore = new FakeCodingStore();
  const reviewStore = new FakeReviewStore();
  const notes = new FakeNoteStore();
  const sessionRows = new Map<string, Row>();
  let sessSeq = 0;
  const openStageSession = vi.fn(async (opts: Row) => {
    const session: Row = { id: `sess-${++sessSeq}`, status: 'idle', ...opts };
    sessionRows.set(session.id as string, session);
    return session;
  });
  const closeSession = vi.fn(async (id: string, _o?: { logWork?: boolean }) => {
    const r = sessionRows.get(id);
    if (!r || r.status === 'closed') return { ok: false, reason: 'gone' };
    r.status = 'closed';
    return { ok: true };
  });
  const runner = { openStageSession, closeSession };
  const sessions = {
    onUpdate: vi.fn(),
    async get(id: string): Promise<Row | undefined> {
      const r = sessionRows.get(id);
      return r ? { ...r } : undefined;
    },
  };
  const board = {
    update: vi.fn(async (..._a: unknown[]) => undefined),
    get: vi.fn(),
  };
  const employees = {
    byId: (id: string) => ({ id }),
    teamLead: () => ({ id: 'atlas' }),
  };
  const plans = {
    attach: vi.fn(async (..._a: unknown[]) => undefined),
    approve: vi.fn(async (..._a: unknown[]) => undefined),
  };
  const proposals = { propose: vi.fn(async () => ({ ok: true })) };
  const review = {
    shipTask: vi.fn(async () => ({ ok: true, prUrl: 'http://pr/1' })),
    reviewSectionLenses: vi.fn(async () => ({ ok: true, findings: [] as string[] })),
    reviewFullImplementation: vi.fn(async () => ({
      verdict: 'pass' as const,
      findings: '',
    })),
  };
  const boardEvents = { emit: vi.fn(), onEvent: vi.fn() };
  const worktrees = { get: vi.fn(() => ({ path: '' })) };

  const svc = new PipelineRunnerService(
    runs as never,
    sectionStore as never,
    runner as never,
    sessions as never,
    board as never,
    employees as never,
    plans as never,
    proposals as never,
    review as never,
    boardEvents as never,
    worktrees as never,
    phaseStore as never,
    codingStore as never,
    reviewStore as never,
    notes as never,
  );
  return { svc, runs, runner, sessionRows };
}

const TEAM = 'T1';
const planMd = (n: number) =>
  `# plan\n\n\`\`\`phases\n${JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `p${i + 1}` })),
  )}\n\`\`\``;

type Driver = { onSessionUpdate: (s: Row) => Promise<void> };

const startOneSection = async (
  svc: PipelineRunnerService,
  runs: FakeRunStore,
  task: number,
) => {
  await svc.start({
    team: TEAM,
    project: 'proj',
    taskId: task,
    worktreeId: `wt-${task}`,
    notifyThread: 'thread',
    kind: 'feature',
    sections: [{ name: 'backend', role: 'phase_backend' }],
  });
};

describe('PipelineRunnerService — advisory planningSubstep', () => {
  it('stamps advisory → gate when the plan turn reports', async () => {
    const { svc, runs } = build();
    const task = 201;
    const spy = vi.spyOn(runs, 'update');
    await startOneSection(svc, runs, task);
    const run = (await runs.getByTask(TEAM, task))!;

    await (svc as never as Driver).onSessionUpdate({
      id: run.sessionId,
      status: 'idle',
      boardTaskId: task,
      team: TEAM,
      notifyThread: 'thread',
      project: 'proj',
      lastReport: planMd(1),
    });

    // The ordered substep transitions: drafting (plan opened) → advisory (plan reported) → gate (pause).
    const substeps = spy.mock.calls
      .map((c) => (c[2] as Row).planningSubstep)
      .filter((v) => v !== undefined);
    expect(substeps).toEqual(['drafting', 'advisory', 'gate']);

    const gated = await runs.getByTask(TEAM, task);
    expect(gated?.planningSubstep).toBe('gate');
    expect(gated?.status).toBe('paused');
  });

  it('a crash mid-advisory re-plans on boot (advisory treated like drafting)', async () => {
    const { svc, runs, runner, sessionRows } = build();
    const task = 202;
    await startOneSection(svc, runs, task);
    const run = (await runs.getByTask(TEAM, task))!;

    // Simulate the crash window: the plan turn stamped 'advisory' but the gate never paused the run,
    // and the in-memory session registry lost its sessions on restart (documented v0 behavior).
    await runs.update(TEAM, run.id as string, { planningSubstep: 'advisory' });
    sessionRows.delete(run.sessionId as string);
    const before = runner.openStageSession.mock.calls.length;

    await svc.resumePipelines();

    const opened = runner.openStageSession.mock.calls.slice(before);
    expect(opened.some((c) => c[0].mode === 'plan')).toBe(true); // re-planned, exactly the drafting path
    const resumed = await runs.getByTask(TEAM, task);
    expect(resumed?.status).toBe('running');
    expect(resumed?.planningSubstep).toBe('drafting');
  });
});
