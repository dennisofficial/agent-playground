import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineRunnerService } from './pipeline-runner.service';

/**
 * Drives the section-driver state machine end-to-end with in-memory fakes (no engines/DB). Asserts the
 * exact session sequence a 2-section feature produces — plan → gate → build(phase×N, each + review) →
 * next section → terminal PR — and that the per-section gate reuse (attach/approve/propose, board
 * cycling) and the mode-encoded build sub-states route correctly.
 */

interface Row {
  [k: string]: unknown;
}

class FakeRunStore {
  rows = new Map<string, Row>();
  private seq = 0;
  async create(n: Row): Promise<Row> {
    const id = `run-${++this.seq}`;
    const row: Row = {
      id,
      team: n.team,
      taskId: n.taskId,
      pipeline: n.pipeline,
      status: n.status ?? 'running',
      currentRole: n.currentRole,
      mode: n.mode,
      worktreeId: n.worktreeId,
      sessionId: n.sessionId,
      notifyThread: n.notifyThread,
      project: n.project,
      kind: n.kind ?? 'feature',
      sectionIndex: n.sectionIndex ?? 0,
      phaseIndex: n.phaseIndex ?? 0,
      planningSubstep: n.planningSubstep,
      overview: n.overview,
    };
    this.rows.set(id, row);
    return { ...row };
  }
  async get(team: string, id: string): Promise<Row | undefined> {
    const r = this.rows.get(id);
    return r && r.team === team ? { ...r } : undefined;
  }
  async getByTask(team: string, taskId: number): Promise<Row | undefined> {
    const all = [...this.rows.values()].filter(
      (r) => r.team === team && r.taskId === taskId,
    );
    return all.length ? { ...all[all.length - 1] } : undefined;
  }
  async update(team: string, id: string, patch: Row): Promise<Row | undefined> {
    const r = this.rows.get(id);
    if (!r) return undefined;
    for (const k of Object.keys(patch))
      r[k] = patch[k] === null ? undefined : patch[k];
    return { ...r };
  }
  async listAllActive(): Promise<Row[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === 'running' || r.status === 'paused')
      .map((r) => ({ ...r }));
  }
}

class FakeSectionStore {
  rows: Row[] = [];
  private seq = 0;
  async createMany(runId: string, team: string, sections: Row[]): Promise<Row[]> {
    return sections.map((s) => {
      const row: Row = {
        id: `sec-${++this.seq}`,
        runId,
        team,
        ordinal: s.ordinal,
        name: s.name,
        brief: s.brief,
        phaseRole: s.phaseRole,
        status: s.status ?? 'pending',
        planMd: undefined,
        phases: undefined,
        phaseCount: undefined,
      };
      this.rows.push(row);
      return { ...row };
    });
  }
  async listForRun(runId: string): Promise<Row[]> {
    return this.rows
      .filter((r) => r.runId === runId)
      .sort((a, b) => (a.ordinal as number) - (b.ordinal as number))
      .map((r) => ({ ...r }));
  }
  async update(id: string, patch: Row): Promise<Row | undefined> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return undefined;
    for (const k of Object.keys(patch))
      r[k] = patch[k] === null ? undefined : patch[k];
    return { ...r };
  }
}

function build() {
  const runs = new FakeRunStore();
  const sectionStore = new FakeSectionStore();
  let sessSeq = 0;
  const openStageSession = vi.fn(async (opts: Row) => ({
    id: `sess-${++sessSeq}`,
    ...opts,
  }));
  const runner = { openStageSession };
  const sessions = { onUpdate: vi.fn(), get: vi.fn(async () => undefined) };
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
  );
  return {
    svc,
    runs,
    sectionStore,
    runner,
    board,
    plans,
    proposals,
    review,
    boardEvents,
    worktrees,
  };
}

const TEAM = 'T1';
const TASK = 7;
const planMd = (n: number) =>
  `# plan\n\n\`\`\`phases\n${JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `p${i + 1}` })),
  )}\n\`\`\``;

describe('PipelineRunnerService — section-driver FSM', () => {
  it('drives a 2-section feature: plan→gate→build(+review per phase)→next section→one PR', async () => {
    const { svc, runs, runner, board, plans, proposals, review } = build();
    const idle = async (lastReport = '') => {
      const run = (await runs.getByTask(TEAM, TASK))!;
      await (svc as never as { onSessionUpdate: (s: Row) => Promise<void> }).onSessionUpdate(
        {
          id: run.sessionId,
          status: 'idle',
          boardTaskId: TASK,
          team: TEAM,
          notifyThread: 'thread',
          project: 'proj',
          lastReport,
        },
      );
    };
    const approve = () =>
      (svc as never as { onBoardEvent: (e: Row) => Promise<void> }).onBoardEvent({
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

    // One gate per section (propose twice); R6: approve uses the SAME employee as attach.
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

    await (svc as never as { onSessionUpdate: (s: Row) => Promise<void> }).onSessionUpdate(
      {
        id: run.sessionId,
        status: 'idle',
        boardTaskId: 9,
        team: TEAM,
        notifyThread: 'thread',
        project: 'proj',
        lastReport: 'fixed it',
      },
    );
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
    const onUpdate = (svc as never as { onSessionUpdate: (s: Row) => Promise<void> })
      .onSessionUpdate;
    const onBoard = (svc as never as { onBoardEvent: (e: Row) => Promise<void> })
      .onBoardEvent;
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
    const { svc, runs, runner } = build();
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
    await (svc as never as { onSessionUpdate: (s: Row) => Promise<void> }).onSessionUpdate(
      {
        id: run.sessionId,
        status: 'idle',
        boardTaskId: 15,
        team: TEAM,
        notifyThread: 'thread',
        project: 'proj',
        lastReport: planMd(1),
      },
    );
    // Now paused at the gate. Simulate "approved during downtime": board.get returns approved.
    expect((await runs.getByTask(TEAM, 15))?.status).toBe('paused');
    const board = (
      svc as never as { board: { get: ReturnType<typeof vi.fn> } }
    ).board;
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
      await (svc as never as { onSessionUpdate: (s: Row) => Promise<void> }).onSessionUpdate(
        {
          id: run.sessionId,
          status: 'idle',
          boardTaskId: 31,
          team: TEAM,
          notifyThread: 'thread',
          project: 'proj',
          lastReport,
        },
      );
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
    await (svc as never as { onBoardEvent: (e: Row) => Promise<void> }).onBoardEvent({
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
      await (svc as never as { onSessionUpdate: (s: Row) => Promise<void> }).onSessionUpdate(
        {
          id: run.sessionId,
          status: 'idle',
          boardTaskId: 11,
          team: TEAM,
          notifyThread: 'thread',
          project: 'proj',
          lastReport,
        },
      );
    };
    await idle('a plan with NO phases block'); // → gate
    await (svc as never as { onBoardEvent: (e: Row) => Promise<void> }).onBoardEvent({
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
    await (svc as never as { onSessionUpdate: (s: Row) => Promise<void> }).onSessionUpdate({
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
});
