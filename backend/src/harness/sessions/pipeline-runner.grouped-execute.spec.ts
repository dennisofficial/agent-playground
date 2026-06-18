import { describe, expect, it, vi } from 'vitest';
import { phaseGroups } from '../memory/pipeline-run-section-store';
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
 * Phase 4 — grouped phase execution. A coding-session GROUP folds CONSECUTIVE phases into ONE execute
 * session sharing one engine context: a `[1,1,2]` grouping opens 2 execute sessions (not 3); each group
 * leaves a fenced `handoff` block that is woven into the NEXT group's prompt; and `answer_section` can
 * re-group the still-pending phases mid-build (an Atlas mechanics call, no re-approval). Driven with the
 * in-memory fakes (no engines/DB); the SQL behind the stores is covered by the int tests.
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
  const replySession = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
  const runner = { openStageSession, closeSession, replySession };
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
  const workspaces = { get: vi.fn(() => ({ path: '' })) };

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
    workspaces as never,
    phaseStore as never,
    codingStore as never,
    reviewStore as never,
    notes as never,
  );
  return {
    svc,
    runs,
    sectionStore,
    phaseStore,
    codingStore,
    runner,
    sessionRows,
    boardEvents,
  };
}

const TEAM = 'T1';

/** A plan whose phases carry explicit `group` numbers — e.g. groups([1,1,2]) → phases 1&2 share a
 * coding session, phase 3 gets its own. */
const groupedPlanMd = (groups: number[]) =>
  `# plan\n\n\`\`\`phases\n${JSON.stringify(
    groups.map((g, i) => ({ id: i + 1, title: `p${i + 1}`, group: g })),
  )}\n\`\`\``;

type Driver = { onSessionUpdate: (s: Row) => Promise<void> };
type BoardDriver = { onBoardEvent: (e: Row) => Promise<void> };

describe('phaseGroups — folds contiguous phases', () => {
  it('folds same-numbered contiguous phases; no group ⇒ one group per phase', () => {
    expect(
      phaseGroups([
        { id: 1, group: 1 },
        { id: 2, group: 1 },
        { id: 3, group: 2 },
      ]).map((g) => g.phases.map((p) => p.id)),
    ).toEqual([[1, 2], [3]]);

    // No `group` anywhere → 1:1 (the pre-Phase-4 default).
    expect(
      phaseGroups([{ id: 1 }, { id: 2 }, { id: 3 }]).map((g) => g.phases.length),
    ).toEqual([1, 1, 1]);

    // A non-contiguous repeat of a number does NOT re-merge (groups are contiguous runs).
    expect(
      phaseGroups([
        { id: 1, group: 1 },
        { id: 2, group: 2 },
        { id: 3, group: 1 },
      ]).map((g) => g.phases.map((p) => p.id)),
    ).toEqual([[1], [2], [3]]);
  });
});

describe('PipelineRunnerService — grouped execution (Phase 4)', () => {
  const drive = (svc: PipelineRunnerService, runs: FakeRunStore, task: number) => {
    const idle = async (lastReport = '') => {
      const run = (await runs.getByTask(TEAM, task))!;
      await (svc as never as Driver).onSessionUpdate({
        id: run.sessionId,
        status: 'idle',
        boardTaskId: task,
        team: TEAM,
        notifyThread: 'thread',
        project: 'proj',
        lastReport,
      });
    };
    const approve = () =>
      (svc as never as BoardDriver).onBoardEvent({
        kind: 'ticket-approved',
        team: TEAM,
        taskId: task,
      });
    return { idle, approve };
  };

  it('a [1,1,2] grouping opens 2 execute sessions and injects group-1 handoff into group-2', async () => {
    const { svc, runs, runner, codingStore } = build();
    const task = 201;
    const { idle, approve } = drive(svc, runs, task);

    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      workspaceId: 'ws-201',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    await idle(groupedPlanMd([1, 1, 2])); // plan → gate
    await approve(); // → group 1 execute (covers phases 1 & 2)

    // Group 1's execute finishes with a handoff block → review group 1.
    await idle(
      '```handoff\nExposed POST /api/upload; FE can assume 200.\n```',
    );
    // Group 1's review passes → group 2 execute opens (covers phase 3).
    await idle('```verdict\n{"blocker":false,"summary":"ok"}\n```');

    const executeCalls = runner.openStageSession.mock.calls.filter(
      (c) => c[0].mode === 'execute',
    );
    // 3 phases, but [1,1,2] folds into 2 groups → exactly 2 execute sessions (not 3).
    expect(executeCalls.length).toBe(2);

    // Group 1's execute prompt lists BOTH phases 1 and 2; group 2's lists phase 3.
    expect(executeCalls[0][0].task).toContain('phase 1');
    expect(executeCalls[0][0].task).toContain('phase 2');
    // The group-2 execute prompt carries the group-1 handoff verbatim.
    expect(executeCalls[1][0].task).toContain('HANDOFF');
    expect(executeCalls[1][0].task).toContain('Exposed POST /api/upload');

    // Two coding-session rows (one per group); group 1 recorded its handoff_out, group 2 its handoff_in.
    const runId = (await runs.getByTask(TEAM, task))!.id as string;
    const sectionId = (
      (svc as never as { sectionStore: FakeSectionStore }).sectionStore
        .rows as Row[]
    ).find((s) => s.runId === runId)!.id as string;
    const coding = await codingStore.listForSection(sectionId);
    expect(coding.length).toBe(2);
    expect(coding[0].handoffOut).toContain('Exposed POST /api/upload');
    expect(coding[1].handoffIn).toContain('Exposed POST /api/upload');
  });

  it('default (no group) preserves 1:1 — 3 phases open 3 execute sessions', async () => {
    const { svc, runs, runner } = build();
    const task = 202;
    const { idle, approve } = drive(svc, runs, task);
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      workspaceId: 'ws-202',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    await idle(groupedPlanMd([1, 2, 3])); // distinct groups → 1:1
    await approve();
    await idle(); // g1 execute → review
    await idle('```verdict\n{"blocker":false,"summary":"ok"}\n```'); // → g2 execute
    await idle();
    await idle('```verdict\n{"blocker":false,"summary":"ok"}\n```'); // → g3 execute
    expect(
      runner.openStageSession.mock.calls.filter((c) => c[0].mode === 'execute')
        .length,
    ).toBe(3);
  });

  it('answer_section regroups the still-pending phases mid-build (no re-approval)', async () => {
    const { svc, runs, runner, codingStore, phaseStore, sessionRows } = build();
    const task = 203;
    const { idle, approve } = drive(svc, runs, task);
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      workspaceId: 'ws-203',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    await idle(groupedPlanMd([1, 2, 3])); // 3 distinct groups
    await approve(); // group 1 (phase 1) is now building; groups 2 & 3 pending

    const runId = (await runs.getByTask(TEAM, task))!.id as string;
    const sectionId = (
      (svc as never as { sectionStore: FakeSectionStore }).sectionStore
        .rows as Row[]
    ).find((s) => s.runId === runId)!.id as string;
    const before = await codingStore.listForSection(sectionId);
    expect(before.length).toBe(3); // one per phase
    expect(before.filter((c) => c.status === 'pending').length).toBe(2);

    // The building execute session reports questions (carrying a regroup proposal); make it answerable.
    const run = (await runs.getByTask(TEAM, task))!;
    const sess = sessionRows.get(run.sessionId as string)!;
    sess.lastReportKind = 'questions';

    // Atlas answers AND merges the two pending phases (2 & 3) into one coding session.
    const r = await svc.answerSectionQuestions(TEAM, task, 'Yes, share context.', [
      { id: 2, group: 9 },
      { id: 3, group: 9 },
    ]);
    expect(r.ok).toBe(true);
    expect(runner.replySession).toHaveBeenCalledWith(
      run.sessionId,
      'Yes, share context.',
      'execute',
    );

    // The pending tail is now ONE coding session shared by phases 2 & 3; group 1 (building) untouched.
    const after = await codingStore.listForSection(sectionId);
    expect(after.length).toBe(2);
    expect(after.filter((c) => c.status === 'pending').length).toBe(1);
    const pending = after.find((c) => c.status === 'pending')!;
    const phaseRows = await phaseStore.listForSection(sectionId);
    const p2 = phaseRows.find((p) => p.planPhaseId === 2)!;
    const p3 = phaseRows.find((p) => p.planPhaseId === 3)!;
    expect(p2.codingSessionId).toBe(pending.id);
    expect(p3.codingSessionId).toBe(pending.id);
  });

  it("relays a build report's ```findings``` block to Atlas (advisory) and still advances to review", async () => {
    const { svc, runs, runner, boardEvents } = build();
    const task = 205;
    const { idle, approve } = drive(svc, runs, task);
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      workspaceId: 'ws-205',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    await idle(groupedPlanMd([1])); // single phase → gate
    await approve(); // group 1 execute building

    // The execute reports a handoff AND an out-of-scope findings block.
    await idle(
      '```handoff\nExposed POST /api/upload.\n```\n\n```findings\n- dead config flag LEGACY_MODE\n```',
    );

    const found = boardEvents.emit.mock.calls
      .map((c) => c[0] as Row)
      .find((e) => e.kind === 'stage-findings');
    expect(found).toBeDefined();
    expect(found!.taskId).toBe(task);
    expect(found!.section).toBe('backend');
    expect(found!.stage).toBe('phase_backend');
    expect(found!.findings).toContain('LEGACY_MODE');
    expect(found!.notifyThread).toBe('thread');

    // Advisory — the run did NOT pause: a review session (mode investigate) opened.
    expect(
      runner.openStageSession.mock.calls.some(
        (c) => c[0].mode === 'investigate',
      ),
    ).toBe(true);
  });

  it('emits no stage-findings when the build report has no findings block', async () => {
    const { svc, runs, boardEvents } = build();
    const task = 206;
    const { idle, approve } = drive(svc, runs, task);
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      workspaceId: 'ws-206',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    await idle(groupedPlanMd([1]));
    await approve();
    await idle('```handoff\nExposed POST /api/upload.\n```'); // no findings block

    expect(
      boardEvents.emit.mock.calls
        .map((c) => c[0] as Row)
        .some((e) => e.kind === 'stage-findings'),
    ).toBe(false);
  });

  it('refuses a regroup that touches an already-building phase', async () => {
    const { svc, runs, sessionRows } = build();
    const task = 204;
    const { idle, approve } = drive(svc, runs, task);
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      workspaceId: 'ws-204',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    await idle(groupedPlanMd([1, 2])); // phase 1 builds, phase 2 pending
    await approve();
    const run = (await runs.getByTask(TEAM, task))!;
    sessionRows.get(run.sessionId as string)!.lastReportKind = 'questions';

    // Phase 1 is building → not eligible to regroup.
    const r = await svc.answerSectionQuestions(TEAM, task, 'answers', [
      { id: 1, group: 5 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/pending/i);
  });
});
