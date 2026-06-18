import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * Drives the EXPLICIT-ROW section-driver state machine end-to-end with in-memory fakes (no engines/DB).
 * Asserts the exact session sequence a 2-section feature produces — plan → gate → build(phase×N, each +
 * review) → next section → terminal PR — driven purely off the section/phase/coding-session row statuses
 * (no positional arithmetic), plus the living-section ops (insert/reorder), dependency-deadlock failure,
 * and boot idempotency. The raw SQL behind these store contracts is covered by pipeline-rows.int.test.ts.
 */

function build() {
  const runs = new FakeRunStore();
  const sectionStore = new FakeSectionStore();
  const phaseStore = new FakePhaseStore();
  const codingStore = new FakeCodingStore();
  const reviewStore = new FakeReviewStore();
  // A session-tracking registry (like the cleanup spec): openStageSession registers an idle session and
  // closeSession flips it closed, so the driver's reclaim runs for real. `inFlight` models the runner's
  // in-process AbortController map — the boot-idempotency / restart-resume liveness signal: a fresh open
  // is in-flight, a close clears it, and a restart (`inFlight.clear()`) loses every controller.
  const sessionRows = new Map<string, Row>();
  const inFlight = new Set<string>();
  let sessSeq = 0;
  const openStageSession = vi.fn(async (opts: Row) => {
    const session: Row = { id: `sess-${++sessSeq}`, status: 'idle', ...opts };
    sessionRows.set(session.id as string, session);
    inFlight.add(session.id as string);
    return session;
  });
  const closeSession = vi.fn(async (id: string, _o?: { logWork?: boolean }) => {
    const r = sessionRows.get(id);
    if (!r || r.status === 'closed') return { ok: false, reason: 'gone' };
    r.status = 'closed';
    inFlight.delete(id);
    return { ok: true };
  });
  const isTurnInFlight = (id: string) => inFlight.has(id);
  const runner = { openStageSession, closeSession, isTurnInFlight };
  const sessions = {
    onUpdate: vi.fn(),
    async get(id: string): Promise<Row | undefined> {
      const r = sessionRows.get(id);
      return r ? { ...r } : undefined;
    },
  };
  const board = {
    update: vi.fn(async (..._a: unknown[]) => undefined),
    get: vi.fn(async (..._a: unknown[]): Promise<Row | undefined> => undefined),
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
  const notes = new FakeNoteStore();

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
  return {
    svc,
    runs,
    sectionStore,
    phaseStore,
    codingStore,
    reviewStore,
    runner,
    sessions,
    sessionRows,
    inFlight,
    board,
    plans,
    proposals,
    review,
    boardEvents,
    worktrees,
    notes,
  };
}

const TEAM = 'T1';
const TASK = 7;
const planMd = (n: number) =>
  `# plan\n\n\`\`\`phases\n${JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `p${i + 1}` })),
  )}\n\`\`\``;

type Driver = { onSessionUpdate: (s: Row) => Promise<void> };
type BoardDriver = { onBoardEvent: (e: Row) => Promise<void> };

describe('PipelineRunnerService — section-driver FSM (explicit rows)', () => {
  it('drives a 2-section feature: plan→gate→build(+review per phase)→next section→one PR', async () => {
    const { svc, runs, runner, board, plans, proposals, review } = build();
    const idle = async (lastReport = '') => {
      const run = (await runs.getByTask(TEAM, TASK))!;
      await (svc as never as Driver).onSessionUpdate({
        id: run.sessionId,
        status: 'idle',
        boardTaskId: TASK,
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
        taskId: TASK,
      });

    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: TASK,
      worktreeId: 'wt-1',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [
        { name: 'backend', role: 'phase_backend' },
        { name: 'frontend', role: 'phase_frontend' },
      ],
    });

    // Section 1 (backend): plan → gate → 2 build phases (each + review) → done.
    await idle(planMd(2)); // backend plan came back → gate
    await approve(); // → build phase 1 (execute)
    await idle(); // phase 1 execute done → review
    await idle('```verdict\n{"blocker":false,"summary":"ok"}\n```'); // review done → phase 2 execute
    await idle(); // phase 2 execute done → review
    await idle(); // phase 2 review done → section 1 done → section 2 plan

    // Section 2 (frontend): plan → gate → 1 build phase (+ review) → terminal PR.
    await idle(planMd(1)); // frontend plan → gate
    await approve(); // → build phase 1 (execute)
    await idle(); // execute done → review
    await idle(); // review done → last section last phase → ship PR

    const modes = runner.openStageSession.mock.calls.map((c) => c[0].mode);
    const roles = runner.openStageSession.mock.calls.map((c) => c[0].role);
    expect(modes).toEqual([
      'plan', // backend plan
      'execute', // backend phase 1
      'investigate', // review 1
      'execute', // backend phase 2
      'investigate', // review 2
      'plan', // frontend plan
      'execute', // frontend phase 1
      'investigate', // review
    ]);
    expect(roles).toEqual([
      'phase_backend',
      'phase_backend',
      'phase_backend',
      'phase_backend',
      'phase_backend',
      'phase_frontend',
      'phase_frontend',
      'phase_frontend',
    ]);

    // One gate per section (propose twice); approve uses the SAME employee as attach.
    expect(proposals.propose).toHaveBeenCalledTimes(2);
    expect(plans.attach).toHaveBeenCalledTimes(2);
    expect(plans.approve.mock.calls.map((c) => c[2] as string)).toEqual([
      'phase_backend',
      'phase_frontend',
    ]);

    // Board cycled to executing on each build; one PR shipped; run done.
    expect(
      board.update.mock.calls.some(
        (c) => (c[2] as { status?: string } | undefined)?.status === 'executing',
      ),
    ).toBe(true);
    expect(review.shipTask).toHaveBeenCalledTimes(1);
    const finalRun = await runs.getByTask(TEAM, TASK);
    expect(finalRun?.status).toBe('done');
  });

  it('materializes phase + coding-session + review rows as the section builds', async () => {
    const { svc, runs, sectionStore, phaseStore, codingStore, reviewStore } = build();
    const idle = async (lastReport = '') => {
      const run = (await runs.getByTask(TEAM, 21))!;
      await (svc as never as Driver).onSessionUpdate({
        id: run.sessionId,
        status: 'idle',
        boardTaskId: 21,
        team: TEAM,
        notifyThread: 'thread',
        project: 'proj',
        lastReport,
      });
    };
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: 21,
      worktreeId: 'wt-21',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    await idle(planMd(2)); // plan → gate
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-approved',
      team: TEAM,
      taskId: 21,
    });
    const section = (await sectionStore.listForRun(
      (await runs.getByTask(TEAM, 21))!.id as string,
    ))[0];
    // Approval materialized 2 phase rows + 2 coding-session rows (1:1), section frozen + building.
    expect(section.frozen).toBe(true);
    expect(section.status).toBe('building');
    const phaseRows = await phaseStore.listForSection(section.id as string);
    const codingRows = await codingStore.listForSection(section.id as string);
    expect(phaseRows.length).toBe(2);
    expect(codingRows.length).toBe(2);
    expect(phaseRows[0].codingSessionId).toBe(codingRows[0].id); // linked
    expect(phaseRows[0].status).toBe('building'); // first phase live

    await idle(); // execute done → review opens (review row created)
    expect((await reviewStore.listForPhase(phaseRows[0].id as string)).length).toBe(1);
    await idle('```verdict\n{"blocker":false,"summary":"clean"}\n```'); // review done → phase 1 done
    const afterReview = await phaseStore.get(phaseRows[0].id as string);
    expect(afterReview?.status).toBe('done');
    const review0 = (await reviewStore.listForPhase(phaseRows[0].id as string))[0];
    expect(review0.status).toBe('done');
    expect(review0.summary).toBe('clean');
  });

  it('runs a bugfix as a single execute session straight to the PR gate', async () => {
    const { svc, runs, runner, review } = build();
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: 9,
      worktreeId: 'wt-2',
      notifyThread: 'thread',
      kind: 'bugfix',
      role: 'phase_backend',
    });
    const run = (await runs.getByTask(TEAM, 9))!;
    expect(run.kind).toBe('bugfix');
    expect(runner.openStageSession.mock.calls[0][0].mode).toBe('execute');

    await (svc as never as Driver).onSessionUpdate({
      id: run.sessionId,
      status: 'idle',
      boardTaskId: 9,
      team: TEAM,
      notifyThread: 'thread',
      project: 'proj',
      lastReport: 'fixed it',
    });
    expect(review.shipTask).toHaveBeenCalledTimes(1);
    expect((await runs.getByTask(TEAM, 9))?.status).toBe('done');
  });

  it('R1: a changes-requested verdict re-plans the section (no wedge); deny fails the run', async () => {
    const { svc, runs, runner } = build();
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: 13,
      worktreeId: 'wt-4',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    const onUpdate = (svc as never as Driver).onSessionUpdate;
    const onBoard = (svc as never as BoardDriver).onBoardEvent;
    const planIdle = async () => {
      const run = (await runs.getByTask(TEAM, 13))!;
      await onUpdate.call(svc, {
        id: run.sessionId,
        status: 'idle',
        boardTaskId: 13,
        team: TEAM,
        notifyThread: 'thread',
        project: 'proj',
        lastReport: planMd(1),
      });
    };
    await planIdle(); // → gate
    await onBoard.call(svc, {
      kind: 'ticket-changes-requested',
      team: TEAM,
      taskId: 13,
    });
    // Re-planned: back to a fresh plan session (not wedged, not building).
    const reRun = (await runs.getByTask(TEAM, 13))!;
    expect(reRun.planningSubstep).toBe('drafting');
    expect(reRun.status).toBe('running');
    expect(runner.openStageSession.mock.calls.map((c) => c[0].mode)).toEqual([
      'plan',
      'plan',
    ]);

    await planIdle(); // → gate again
    await onBoard.call(svc, { kind: 'ticket-denied', team: TEAM, taskId: 13 });
    expect((await runs.getByTask(TEAM, 13))?.status).toBe('failed');
  });

  it('R2: boot-reconcile resumes a paused+gate run whose board is already approved', async () => {
    const { svc, runs, runner, board } = build();
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: 15,
      worktreeId: 'wt-5',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    const run = (await runs.getByTask(TEAM, 15))!;
    await (svc as never as Driver).onSessionUpdate({
      id: run.sessionId,
      status: 'idle',
      boardTaskId: 15,
      team: TEAM,
      notifyThread: 'thread',
      project: 'proj',
      lastReport: planMd(1),
    });
    // Now paused at the gate. Simulate "approved during downtime": board.get returns approved.
    expect((await runs.getByTask(TEAM, 15))?.status).toBe('paused');
    board.get.mockResolvedValue({ status: 'approved' });
    await svc.resumePipelines();
    // The gate was replayed → building (a phase execute session opened).
    expect(
      runner.openStageSession.mock.calls.some((c) => c[0].mode === 'execute'),
    ).toBe(true);
    expect((await runs.getByTask(TEAM, 15))?.status).toBe('running');
  });

  it('design section pauses at the gate; skip skips it + its implementer and ships the functional version', async () => {
    const { svc, runs, runner, review, boardEvents } = build();
    const idle = async (lastReport = '') => {
      const run = (await runs.getByTask(TEAM, 31))!;
      await (svc as never as Driver).onSessionUpdate({
        id: run.sessionId,
        status: 'idle',
        boardTaskId: 31,
        team: TEAM,
        notifyThread: 'thread',
        project: 'proj',
        lastReport,
      });
    };
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: 31,
      worktreeId: 'wt-6',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [
        { name: 'backend', role: 'phase_backend' },
        { name: 'design', role: 'design' },
        { name: 'frontend-redesign', role: 'phase_frontend' },
      ],
    });
    await idle(planMd(1)); // backend plan → gate
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-approved',
      team: TEAM,
      taskId: 31,
    });
    await idle(); // backend phase → review
    await idle(); // review → backend done → reaches the DESIGN gate (no session opened)

    const paused = (await runs.getByTask(TEAM, 31))!;
    expect(paused.status).toBe('paused');
    expect(paused.planningSubstep).toBe('awaiting_design');
    expect(runner.openStageSession.mock.calls.map((c) => c[0].mode)).toEqual([
      'plan',
      'execute',
      'investigate',
    ]);
    expect(
      boardEvents.emit.mock.calls.some((c) => c[0]?.kind === 'design-gate'),
    ).toBe(true);

    // Skip → design + its implementer skipped → no sections left → ship functional version.
    const r = await svc.skipDesign(TEAM, 31);
    expect(r.ok).toBe(true);
    expect(review.shipTask).toHaveBeenCalledTimes(1);
    expect((await runs.getByTask(TEAM, 31))?.status).toBe('done');
  });

  it('attach_design unzips into the worktree and the next section builds against it', async () => {
    const { svc, runs, runner, worktrees } = build();
    const wtPath = mkdtempSync(join(tmpdir(), 'wt-'));
    const srcDir = mkdtempSync(join(tmpdir(), 'design-src-'));
    writeFileSync(join(srcDir, 'tokens.json'), '{"color":"blue"}');
    const zipPath = join(srcDir, 'design.zip');
    execFileSync('zip', ['-j', zipPath, join(srcDir, 'tokens.json')]);
    worktrees.get.mockReturnValue({ path: wtPath });

    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: 41,
      worktreeId: 'wt-7',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [
        { name: 'design', role: 'design' }, // design FIRST → immediate gate
        { name: 'frontend', role: 'phase_frontend' },
      ],
    });
    expect((await runs.getByTask(TEAM, 41))?.planningSubstep).toBe('awaiting_design');

    const r = await svc.attachDesign(TEAM, 41, zipPath);
    expect(r.ok).toBe(true);
    expect(existsSync(join(wtPath, 'design', 'tokens.json'))).toBe(true);

    const resumed = (await runs.getByTask(TEAM, 41))!;
    expect(resumed.planningSubstep).toBe('drafting'); // advanced to the implementer's plan
    expect(
      runner.openStageSession.mock.calls.some(
        (c) => c[0].mode === 'plan' && c[0].role === 'phase_frontend',
      ),
    ).toBe(true);
  });

  it('rejects a non-local (URL) design source', async () => {
    const { svc, runs } = build();
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: 51,
      worktreeId: 'wt-8',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'design', role: 'design' }],
    });
    expect((await runs.getByTask(TEAM, 51))?.planningSubstep).toBe('awaiting_design');
    const r = await svc.attachDesign(TEAM, 51, 'https://example.com/design.zip');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/LOCAL path/i);
  });

  it('falls back to one phase when the plan has no phases block', async () => {
    const { svc, runs, runner } = build();
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: 11,
      worktreeId: 'wt-3',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    const idle = async (lastReport = '') => {
      const run = (await runs.getByTask(TEAM, 11))!;
      await (svc as never as Driver).onSessionUpdate({
        id: run.sessionId,
        status: 'idle',
        boardTaskId: 11,
        team: TEAM,
        notifyThread: 'thread',
        project: 'proj',
        lastReport,
      });
    };
    await idle('a plan with NO phases block'); // → gate
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-approved',
      team: TEAM,
      taskId: 11,
    });
    await idle(); // single phase execute → review
    await idle(); // review → last phase → ship
    // plan, execute, investigate (exactly one build phase)
    expect(runner.openStageSession.mock.calls.map((c) => c[0].mode)).toEqual([
      'plan',
      'execute',
      'investigate',
    ]);
  });

  it('threads the dispatch overview (high-level plan) into every section plan prompt', async () => {
    const { svc, runner } = build();
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: 81,
      worktreeId: 'wt-10',
      notifyThread: 'thread',
      kind: 'feature',
      overview: 'HIGH-LEVEL: build a profile-picture upload across the stack.',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    const planCall = runner.openStageSession.mock.calls.find(
      (c) => c[0].mode === 'plan',
    );
    expect(planCall?.[0].task).toContain('HIGH-LEVEL PLAN');
    expect(planCall?.[0].task).toContain('profile-picture upload');
  });

  it('relays a plan session that asks QUESTIONS (no approval card); answer_section delivers the reply', async () => {
    const { svc, runs, proposals, boardEvents, runner } = build();
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: 71,
      worktreeId: 'wt-9',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    const run0 = (await runs.getByTask(TEAM, 71))!;

    // The plan session ends with QUESTIONS, not a finished plan — must NOT be proposed as a plan.
    await (svc as never as Driver).onSessionUpdate({
      id: run0.sessionId,
      status: 'idle',
      boardTaskId: 71,
      team: TEAM,
      notifyThread: 'thread',
      project: 'proj',
      lastReport: 'Q1 — which datastore should I use?',
      lastReportKind: 'questions',
    });

    expect(proposals.propose).not.toHaveBeenCalled();
    expect(
      boardEvents.emit.mock.calls.some(
        (c) => (c[0] as Row)?.kind === 'section-questions',
      ),
    ).toBe(true);
    const afterQ = (await runs.getByTask(TEAM, 71))!;
    expect(afterQ.planningSubstep).toBe('drafting'); // still drafting, NOT paused at a gate
    expect(afterQ.status).toBe('running');

    // answer_section feeds Atlas's answers back into the SAME session (mode 'plan'), via replySession.
    const sessions = (
      svc as never as { sessions: { get: ReturnType<typeof vi.fn> } }
    ).sessions;
    sessions.get = vi.fn(async () => ({
      id: afterQ.sessionId,
      status: 'idle',
      lastReportKind: 'questions',
      mode: 'plan',
    }));
    (runner as Row).replySession = vi.fn(async () => ({ ok: true }));
    const r = await svc.answerSectionQuestions(TEAM, 71, 'Use Postgres.');
    expect(r.ok).toBe(true);
    expect((runner as Row).replySession).toHaveBeenCalledWith(
      afterQ.sessionId,
      'Use Postgres.',
      'plan',
    );
  });

  // ── living sections (Phase 2) ───────────────────────────────────────────────

  it('insert_section wedges a new section into the pending tail after committed work', async () => {
    const { svc, runs, sectionStore } = build();
    const task = 91;
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
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: 'wt-91',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [
        { name: 'backend', role: 'phase_backend' },
        { name: 'frontend', role: 'phase_frontend' },
      ],
    });
    // Drive backend fully done → frozen; frontend now planning.
    await idle(planMd(1)); // backend plan → gate
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-approved',
      team: TEAM,
      taskId: task,
    });
    await idle(); // execute → review
    await idle(); // review → backend done → frontend plan opens
    const runId = (await runs.getByTask(TEAM, task))!.id as string;
    const backend = (await sectionStore.listForRun(runId)).find(
      (s) => s.name === 'backend',
    )!;
    expect(backend.status).toBe('done');
    expect(backend.frozen).toBe(true);

    // Wedge an analytics section after the executed backend.
    const r = await svc.insertSection(TEAM, task, 'backend', {
      name: 'analytics',
      phaseRole: 'phase_backend',
    });
    expect(r.ok).toBe(true);
    const after = await sectionStore.listForRun(runId);
    const analytics = after.find((s) => s.name === 'analytics')!;
    expect(analytics).toBeTruthy();
    expect(analytics.status).toBe('pending');
    expect(analytics.ordinal).toBe(15); // midpoint of backend(10) and frontend(20)
    expect(analytics.dependsOn).toEqual([10]); // depends on the anchor
  });

  it('reorder_sections reorders the pending tail with NO gate, but refuses a non-pending section', async () => {
    const { svc, runs, sectionStore, proposals } = build();
    const task = 92;
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
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: 'wt-92',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [
        { name: 'backend', role: 'phase_backend' },
        { name: 'frontend', role: 'phase_frontend' },
        { name: 'analytics', role: 'phase_backend' },
      ],
    });
    await idle(planMd(1)); // backend → gate
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-approved',
      team: TEAM,
      taskId: task,
    });
    const proposalsBefore = proposals.propose.mock.calls.length;
    const runId = (await runs.getByTask(TEAM, task))!.id as string;

    // Reorder the two PENDING sections → no approval card (gate the substance).
    const ok = await svc.reorderSections(TEAM, task, ['analytics', 'frontend']);
    expect(ok.ok).toBe(true);
    const order = (await sectionStore.listForRun(runId))
      .filter((s) => s.status === 'pending')
      .map((s) => s.name);
    expect(order).toEqual(['analytics', 'frontend']);
    expect(proposals.propose.mock.calls.length).toBe(proposalsBefore); // no new gate

    // Listing the building backend is refused (only pending sections move).
    const refused = await svc.reorderSections(TEAM, task, ['backend', 'frontend']);
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/building/i);
  });

  it('a dependency deadlock (no runnable pending section) fails the run loudly — never hangs', async () => {
    const { svc, runs, sectionStore } = build();
    const task = 93;
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
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: 'wt-93',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [
        { name: 'backend', role: 'phase_backend' },
        { name: 'a', role: 'phase_backend' },
        { name: 'b', role: 'phase_backend' },
      ],
    });
    // Inject a dependency cycle into the two pending sections (a↔b) — unreachable through the tools,
    // but the runner must fail loudly rather than hang if it ever arises.
    const runId = (await runs.getByTask(TEAM, task))!.id as string;
    const all = await sectionStore.listForRun(runId);
    const a = sectionStore.rows.find((s) => s.name === 'a')!;
    const b = sectionStore.rows.find((s) => s.name === 'b')!;
    a.dependsOn = [b.ordinal];
    b.dependsOn = [a.ordinal];
    void all;

    await idle(planMd(1)); // backend plan → gate
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-approved',
      team: TEAM,
      taskId: task,
    });
    await idle(); // execute → review
    await idle(); // review → backend done → advance: a/b both blocked → deadlock → fail
    expect((await runs.getByTask(TEAM, task))?.status).toBe('failed');
  });

  // ── cross-section defect → Atlas decides (Phase 5d) ─────────────────────────

  /** Drive a single-section feature to a per-group review BLOCKER → the run pauses at a stage decision. */
  const toBlockerPause = async (
    svc: PipelineRunnerService,
    runs: FakeRunStore,
    task: number,
  ) => {
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
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: `wt-${task}`,
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    await idle(planMd(1)); // plan → gate
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-approved',
      team: TEAM,
      taskId: task,
    });
    await idle(); // execute → review
    await idle('```verdict\n{"blocker":true,"summary":"seam defect"}\n```'); // blocker → pause
    return { idle };
  };

  it('a review blocker pauses the run and emits a stage-decision (no ship)', async () => {
    const { svc, runs, review, boardEvents, notes } = build();
    const task = 101;
    await toBlockerPause(svc, runs, task);

    const paused = (await runs.getByTask(TEAM, task))!;
    expect(paused.status).toBe('paused');
    expect(paused.planningSubstep).toBe('stage_decision');
    expect(review.shipTask).not.toHaveBeenCalled();
    const decisions = boardEvents.emit.mock.calls
      .map((c) => c[0] as Row)
      .filter((e) => e.kind === 'stage-decision');
    expect(decisions.length).toBe(1);
    expect(decisions[0].section).toBe('backend');
    expect(String(decisions[0].findings)).toContain('seam defect');
    // The findings are parked durably so a restart can recover them.
    expect((await notes.listForTask(TEAM, task)).notes.length).toBe(1);
  });

  it('dispatch_fixup_session opens a fix-up session that re-enters the PR gate and ships', async () => {
    const { svc, runs, runner, review } = build();
    const task = 102;
    const { idle } = await toBlockerPause(svc, runs, task);
    const execBefore = runner.openStageSession.mock.calls.filter(
      (c) => c[0].mode === 'execute',
    ).length;

    const r = await svc.dispatchFixup(TEAM, task, 'just patch the seam');
    expect(r.ok).toBe(true);
    const running = (await runs.getByTask(TEAM, task))!;
    expect(running.status).toBe('running');
    expect(running.planningSubstep).toBe('fixup');
    // A fresh execute session opened in the integrated worktree.
    expect(
      runner.openStageSession.mock.calls.filter((c) => c[0].mode === 'execute')
        .length,
    ).toBe(execBefore + 1);

    // The fix-up session reports → re-enters the PR gate (full-impl review passes) → ships.
    await idle('fixed the seam');
    expect(review.reviewFullImplementation).toHaveBeenCalled();
    expect(review.shipTask).toHaveBeenCalledTimes(1);
    expect((await runs.getByTask(TEAM, task))?.status).toBe('done');
  });

  it('reopen_section drops the section to planning with the defect and re-gates', async () => {
    const { svc, runs, runner, sectionStore, phaseStore, proposals } = build();
    const task = 103;
    const { idle } = await toBlockerPause(svc, runs, task);
    const runId = (await runs.getByTask(TEAM, task))!.id as string;
    const section = (await sectionStore.listForRun(runId)).find(
      (s) => s.name === 'backend',
    )!;
    // It had phase rows from the build.
    expect((await phaseStore.listForSection(section.id as string)).length).toBeGreaterThan(0);
    const proposalsBefore = proposals.propose.mock.calls.length;

    const r = await svc.reopenSection(TEAM, task, 'backend', 'the plan missed auth');
    expect(r.ok).toBe(true);
    const reopened = (await sectionStore.listForRun(runId)).find(
      (s) => s.name === 'backend',
    )!;
    expect(reopened.status).toBe('planning');
    expect(reopened.frozen).toBe(false);
    // Built rows cleared so the re-approval re-materializes.
    expect((await phaseStore.listForSection(section.id as string)).length).toBe(0);
    // A fresh plan session opened, carrying the defect as deny-style feedback.
    const lastPlan = [...runner.openStageSession.mock.calls]
      .reverse()
      .find((c) => c[0].mode === 'plan');
    expect(lastPlan?.[0].role).toBe('phase_backend');
    expect(String(lastPlan?.[0].task)).toContain('the plan missed auth');
    const afterReopen = (await runs.getByTask(TEAM, task))!;
    expect(afterReopen.status).toBe('running');
    expect(afterReopen.planningSubstep).toBe('drafting');

    // The re-plan reports → it gates again for Dennis (re-approval).
    await idle(planMd(1));
    expect(proposals.propose.mock.calls.length).toBe(proposalsBefore + 1);
  });

  it('fix-up / reopen refuse with a helpful message when the run is not at a review decision', async () => {
    const { svc, runs } = build();
    const task = 104;
    // No run at all.
    expect((await svc.dispatchFixup(TEAM, task)).ok).toBe(false);
    expect((await svc.reopenSection(TEAM, task, 'backend', 'x')).ok).toBe(false);

    // A run that's mid-build (not paused at a decision) is refused too.
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: `wt-${task}`,
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    const fix = await svc.dispatchFixup(TEAM, task);
    expect(fix.ok).toBe(false);
    expect(fix.message).toMatch(/review decision/i);
  });

  it('boot idempotency: reopenCurrentStep twice opens exactly one session for a live row', async () => {
    const { svc, runs, runner, inFlight } = build();
    const task = 94;
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
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: 'wt-94',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    await idle(planMd(1)); // plan → gate
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-approved',
      team: TEAM,
      taskId: task,
    });
    // Now a phase is building (execute session open). Simulate a restart: the process loses every
    // in-flight AbortController (the durable session row survives, but its turn is dead).
    inFlight.clear();
    const before = runner.openStageSession.mock.calls.length;

    const reopen = (svc as never as { reopenCurrentStep: (r: Row) => Promise<void> })
      .reopenCurrentStep;
    await reopen.call(svc, (await runs.getByTask(TEAM, task))!); // turn not in flight → opens one
    await reopen.call(svc, (await runs.getByTask(TEAM, task))!); // freshly reopened turn live → skips
    expect(runner.openStageSession.mock.calls.length - before).toBe(1);
  });

  // A harness restart must RESUME an actively-building run from its durable rows, not fail it. The
  // regression: the durable PostgresSessionRegistry reconciles the interrupted session to 'failed' on
  // boot, and resumePipelines used to route a 'failed' session through onSessionUpdate → failRun,
  // terminally killing the run + dumping the ticket back on the backlog (the bug Dennis hit). Drive a
  // run to a phase-2 build (phase 1 already done), simulate the restart, and assert it resumes.
  const driveToPhase2 = async (svc: PipelineRunnerService, runs: FakeRunStore, task: number) => {
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
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: `wt-${task}`,
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    await idle(planMd(2)); // plan → gate
    await (svc as never as BoardDriver).onBoardEvent({
      kind: 'ticket-approved',
      team: TEAM,
      taskId: task,
    });
    await idle(); // phase 1 execute done → review
    await idle('```verdict\n{"blocker":false,"summary":"ok"}\n```'); // review done → phase 2 execute
  };

  for (const restart of [
    {
      label: 'reconciled-failed session (durable registry on boot)',
      mutate: (row: Row) => (row.status = 'failed'),
    },
    {
      label: 'stale-running session (reconcile-vs-resume boot race)',
      mutate: (row: Row) => (row.status = 'running'), // reconcile hasn't run yet — the race Codex flagged
    },
  ]) {
    it(`restart resumes a building run — ${restart.label} — instead of failing it`, async () => {
      const { svc, runs, sectionStore, phaseStore, runner, sessionRows, inFlight, board, boardEvents } =
        build();
      const task = 77;
      await driveToPhase2(svc, runs, task);

      const run = (await runs.getByTask(TEAM, task))!;
      const section = (await sectionStore.listForRun(run.id as string))[0];
      const phasesBefore = await phaseStore.listForSection(section.id as string);
      expect(phasesBefore.find((p) => p.planPhaseId === 1)?.status).toBe('done'); // phase 1 finished
      expect(phasesBefore.find((p) => p.planPhaseId === 2)?.status).toBe('building');

      // Simulate the restart: the live execute session is reconciled (or left stale), and the process
      // loses every in-flight controller.
      const live = sessionRows.get(run.sessionId as string)!;
      restart.mutate(live);
      inFlight.clear();
      const before = runner.openStageSession.mock.calls.length;

      await svc.resumePipelines();

      const resumed = (await runs.getByTask(TEAM, task))!;
      expect(resumed.status).toBe('running'); // NOT 'failed'
      // failRun would reset the ticket to 'open' and emit a run-failed board event — neither happened.
      expect(
        board.update.mock.calls.some(
          (c) => (c[2] as { status?: string } | undefined)?.status === 'open',
        ),
      ).toBe(false);
      expect(
        boardEvents.emit.mock.calls.some((c) => (c[0] as Row).kind === 'run-failed'),
      ).toBe(false);
      // Exactly one new stage session opened for the live (phase-2) step.
      expect(runner.openStageSession.mock.calls.length - before).toBe(1);
      expect(runner.openStageSession.mock.calls.at(-1)?.[0].mode).toBe('execute');
      // Prior progress survived: phase 1 still done.
      const phasesAfter = await phaseStore.listForSection(section.id as string);
      expect(phasesAfter.find((p) => p.planPhaseId === 1)?.status).toBe('done');
    });
  }

  it('restart resumes an interrupted PLAN session (re-plans the section, never fails the run)', async () => {
    const { svc, runs, sectionStore, runner, sessionRows, inFlight, board, boardEvents } = build();
    const task = 78;
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: `wt-${task}`,
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });
    // start() opened the section's plan session; it never reported (no planMd) — the section is still
    // 'planning'. Simulate the restart mid-plan.
    const run = (await runs.getByTask(TEAM, task))!;
    sessionRows.get(run.sessionId as string)!.status = 'failed';
    inFlight.clear();
    const before = runner.openStageSession.mock.calls.length;

    await svc.resumePipelines();

    const resumed = (await runs.getByTask(TEAM, task))!;
    expect(resumed.status).toBe('running'); // NOT 'failed'
    expect(
      boardEvents.emit.mock.calls.some((c) => (c[0] as Row).kind === 'run-failed'),
    ).toBe(false);
    expect(
      board.update.mock.calls.some(
        (c) => (c[2] as { status?: string } | undefined)?.status === 'open',
      ),
    ).toBe(false);
    expect(runner.openStageSession.mock.calls.length - before).toBe(1);
    expect(runner.openStageSession.mock.calls.at(-1)?.[0].mode).toBe('plan'); // re-plans
    expect((await sectionStore.listForRun(run.id as string))[0].status).toBe('planning');
  });
});
