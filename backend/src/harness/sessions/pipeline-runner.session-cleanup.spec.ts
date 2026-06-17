import { describe, expect, it, vi } from 'vitest';
import { PipelineRunnerService } from './pipeline-runner.service';

/**
 * Pipeline stage sessions are owned by synthetic phase-configs that never call close_session, so the
 * driver must reclaim them itself — otherwise they pile up as idle/failed orphans in the run's worktree
 * and later deadlock worktree cleanup (remove_worktree refuses while any session is open). These tests
 * pin that invariant: every stage session a run opens is closed by the time the run reaches a terminal
 * state, and the driver closes them WITHOUT a worklog write (intermediate turns aren't standup-worthy).
 *
 * Unlike the FSM spec's fakes (which leave `sessions.get` undefined), this harness tracks real session
 * rows so close is actually exercised.
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

/** A minimal session registry that tracks status, plus a runner whose openStageSession registers a
 * session and whose closeSession flips it to 'closed' — so the driver's reclaim path runs for real. */
function build(opts: { shipOk?: boolean } = {}) {
  const { shipOk = true } = opts;
  const runs = new FakeRunStore();
  const sectionStore = new FakeSectionStore();
  const sessionRows = new Map<string, Row>();
  let sessSeq = 0;

  const sessions = {
    onUpdate: vi.fn(),
    async get(id: string): Promise<Row | undefined> {
      const r = sessionRows.get(id);
      return r ? { ...r } : undefined;
    },
  };
  const openStageSession = vi.fn(async (o: Row) => {
    const session: Row = {
      id: `sess-${++sessSeq}`,
      status: 'idle', // already reported back; the driver supersedes it on the next open
      ownerBot: o.role,
      ...o,
    };
    sessionRows.set(session.id as string, session);
    return session;
  });
  const closeSession = vi.fn(
    async (id: string, _o?: { logWork?: boolean }) => {
      const r = sessionRows.get(id);
      if (!r) return { ok: false, reason: `No session "${id}".` };
      if (r.status === 'closed') return { ok: false, reason: 'already closed' };
      r.status = 'closed';
      return { ok: true };
    },
  );
  const runner = { openStageSession, closeSession };
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
    shipTask: vi.fn(async () =>
      shipOk
        ? { ok: true, prUrl: 'http://pr/1' }
        : { ok: false, reason: 'ship blew up' },
    ),
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
  const openSessions = () =>
    [...sessionRows.values()].filter((s) => s.status !== 'closed');
  return { svc, runs, runner, openSessions, sessionRows };
}

const TEAM = 'T1';

describe('PipelineRunnerService — stage-session reclaim', () => {
  type Driver = { onSessionUpdate: (s: Row) => Promise<void> };
  type BoardDriver = { onBoardEvent: (e: Row) => Promise<void> };
  const planMd = (n: number) =>
    `# plan\n\n\`\`\`phases\n${JSON.stringify(
      Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `p${i + 1}` })),
    )}\n\`\`\``;

  it('closes every stage session a completed feature run opens (no idle orphans left in the worktree)', async () => {
    const { svc, runs, runner, openSessions } = build();
    const task = 7;
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

    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: 'wt-1',
      notifyThread: 'thread',
      kind: 'feature',
      sections: [{ name: 'backend', role: 'phase_backend' }],
    });

    // Mid-run: each transition supersedes the prior session, so at most one is ever open.
    await idle(planMd(1)); // plan → gate
    expect(openSessions().length).toBeLessThanOrEqual(1);
    await approve(); // → build phase 1 (execute)
    expect(openSessions().length).toBeLessThanOrEqual(1);
    await idle(); // execute done → review
    expect(openSessions().length).toBeLessThanOrEqual(1);
    await idle(); // review done → last phase of last section → ship PR

    // Run is done and NOTHING is left open — the deadlock precondition can't arise.
    expect((await runs.getByTask(TEAM, task))?.status).toBe('done');
    expect(openSessions()).toEqual([]);

    // Reclaim never writes a worklog (intermediate stage turns aren't standup-worthy).
    expect(runner.closeSession).toHaveBeenCalled();
    for (const call of runner.closeSession.mock.calls)
      expect(call[1]).toEqual({ logWork: false });
  });

  it('reclaims the session when a run fails (a failed stage session is closed too)', async () => {
    const { svc, runs, runner, openSessions } = build();
    const task = 9;
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: 'wt-2',
      notifyThread: 'thread',
      kind: 'bugfix',
      role: 'phase_backend',
    });
    const run = (await runs.getByTask(TEAM, task))!;
    await (svc as never as Driver).onSessionUpdate({
      id: run.sessionId,
      status: 'failed',
      boardTaskId: task,
      team: TEAM,
      notifyThread: 'thread',
      project: 'proj',
    });

    expect((await runs.getByTask(TEAM, task))?.status).toBe('failed');
    expect(openSessions()).toEqual([]);
    expect(runner.closeSession).toHaveBeenCalledWith(run.sessionId, {
      logWork: false,
    });
  });

  it('reclaims the session when the terminal PR ship fails', async () => {
    const { svc, runs, openSessions } = build({ shipOk: false });
    const task = 11;
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: 'wt-3',
      notifyThread: 'thread',
      kind: 'bugfix',
      role: 'phase_backend',
    });
    const run = (await runs.getByTask(TEAM, task))!;
    await (svc as never as Driver).onSessionUpdate({
      id: run.sessionId,
      status: 'idle',
      boardTaskId: task,
      team: TEAM,
      notifyThread: 'thread',
      project: 'proj',
      lastReport: 'fixed it',
    });

    expect((await runs.getByTask(TEAM, task))?.status).toBe('failed');
    expect(openSessions()).toEqual([]);
  });
});
