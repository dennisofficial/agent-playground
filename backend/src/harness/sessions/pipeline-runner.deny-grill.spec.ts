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
 * Deny-grill (Phase 3c): a 'ticket-changes-requested' verdict re-plans the active section AND carries
 * Dennis's feedback into the new plan prompt as authoritative direction — instead of dropping it on the
 * floor and re-deriving the same plan. The feedback is read back from the changes-requested ticket note
 * the approval card durably wrote. 'ticket-denied' stays the nuke path (fails the run).
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
  return { svc, runs, runner, notes };
}

const TEAM = 'T1';
const planMd = (n: number) =>
  `# plan\n\n\`\`\`phases\n${JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `p${i + 1}` })),
  )}\n\`\`\``;

type Driver = { onSessionUpdate: (s: Row) => Promise<void> };
type BoardDriver = { onBoardEvent: (e: Row) => Promise<void> };

describe('PipelineRunnerService — deny-grill (changes-requested feedback injection)', () => {
  const startGated = async (svc: PipelineRunnerService, runs: FakeRunStore, task: number) => {
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: `wt-${task}`,
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
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
    expect((await runs.getByTask(TEAM, task))?.planningSubstep).toBe('gate');
  };

  it('re-plans with Dennis’s changes-requested note woven in as authoritative direction', async () => {
    const { svc, runs, runner, notes } = build();
    const task = 101;
    await startGated(svc, runs, task);

    // The approval card wrote a changes-requested note (its exact phrasing) before the verdict event.
    await notes.add(
      TEAM,
      task,
      'dennis',
      'Requested changes on the proposal (via the Slack approval card): Use Postgres, not Mongo, and add rate limiting on the upload endpoint.',
    );
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-changes-requested',
      team: TEAM,
      taskId: task,
    });

    // Re-planned: a fresh plan session, drafting again.
    const reRun = (await runs.getByTask(TEAM, task))!;
    expect(reRun.planningSubstep).toBe('drafting');
    expect(reRun.status).toBe('running');
    const planCalls = runner.openStageSession.mock.calls.filter(
      (c) => c[0].mode === 'plan',
    );
    expect(planCalls.length).toBe(2);
    const rePlanPrompt = planCalls[1][0].task as string;
    expect(rePlanPrompt).toContain('Use Postgres, not Mongo, and add rate limiting');
    expect(rePlanPrompt).toContain('AUTHORITATIVE');
    expect(rePlanPrompt).toContain('SENT IT BACK');
  });

  it('re-plans WITHOUT a feedback block when no changes-requested note exists (degrades, never throws)', async () => {
    const { svc, runs, runner } = build();
    const task = 102;
    await startGated(svc, runs, task);

    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-changes-requested',
      team: TEAM,
      taskId: task,
    });

    const planCalls = runner.openStageSession.mock.calls.filter(
      (c) => c[0].mode === 'plan',
    );
    expect(planCalls.length).toBe(2);
    const rePlanPrompt = planCalls[1][0].task as string;
    expect(rePlanPrompt).not.toContain('SENT IT BACK');
    expect((await runs.getByTask(TEAM, task))?.planningSubstep).toBe('drafting');
  });

  it('ignores a "(no notes)" deny — re-plans with no feedback block', async () => {
    const { svc, runs, runner, notes } = build();
    const task = 103;
    await startGated(svc, runs, task);

    await notes.add(
      TEAM,
      task,
      'dennis',
      'Requested changes on the proposal (via the Slack approval card): (no notes)',
    );
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-changes-requested',
      team: TEAM,
      taskId: task,
    });

    const rePlanPrompt = runner.openStageSession.mock.calls.filter(
      (c) => c[0].mode === 'plan',
    )[1][0].task as string;
    expect(rePlanPrompt).not.toContain('SENT IT BACK');
  });

  it('uses the LATEST changes-requested note when several exist', async () => {
    const { svc, runs, runner, notes } = build();
    const task = 104;
    await startGated(svc, runs, task);

    await notes.add(
      TEAM,
      task,
      'dennis',
      'Requested changes on the proposal (via the Slack approval card): first round — split the migration out.',
    );
    await notes.add(
      TEAM,
      task,
      'dennis',
      'Requested changes on the proposal (via the Slack approval card): second round — also gate it behind a feature flag.',
    );
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-changes-requested',
      team: TEAM,
      taskId: task,
    });

    const rePlanPrompt = runner.openStageSession.mock.calls.filter(
      (c) => c[0].mode === 'plan',
    )[1][0].task as string;
    expect(rePlanPrompt).toContain('second round — also gate it behind a feature flag');
    expect(rePlanPrompt).not.toContain('first round');
  });

  it('a denied ticket still fails the run (the nuke path is untouched by the grill)', async () => {
    const { svc, runs } = build();
    const task = 105;
    await startGated(svc, runs, task);

    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-denied',
      team: TEAM,
      taskId: task,
    });
    expect((await runs.getByTask(TEAM, task))?.status).toBe('failed');
  });
});
