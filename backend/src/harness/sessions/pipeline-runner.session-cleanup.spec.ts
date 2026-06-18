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
import { fakeSandboxRegistry } from '../workspaces/workspace-git.test-util';

/**
 * Pipeline stage sessions are owned by synthetic phase-configs that never call close_session, so the
 * driver must reclaim them itself — otherwise they pile up as idle/failed orphans in the run's workspace
 * and later deadlock workspace cleanup (remove_workspace refuses while any session is open). These tests
 * pin that invariant: every stage session a run opens is closed by the time the run reaches a terminal
 * state, and the driver closes them WITHOUT a worklog write (intermediate turns aren't standup-worthy).
 *
 * Unlike the FSM spec's fakes (which leave `sessions.get` undefined), this harness tracks real session
 * rows so close is actually exercised.
 */

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
    shipTask: vi.fn(async () =>
      shipOk
        ? { ok: true, prUrl: 'http://pr/1' }
        : { ok: false, reason: 'ship blew up' },
    ),
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
    new FakePhaseStore() as never,
    new FakeCodingStore() as never,
    new FakeReviewStore() as never,
    new FakeNoteStore() as never,
    fakeSandboxRegistry() as never,
  );
  const openSessions = () =>
    [...sessionRows.values()].filter((s) => s.status !== 'closed');
  return { svc, runs, runner, board, boardEvents, openSessions, sessionRows };
}

const TEAM = 'T1';

describe('PipelineRunnerService — stage-session reclaim', () => {
  type Driver = { onSessionUpdate: (s: Row) => Promise<void> };
  type BoardDriver = { onBoardEvent: (e: Row) => Promise<void> };
  const planMd = (n: number) =>
    `# plan\n\n\`\`\`phases\n${JSON.stringify(
      Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `p${i + 1}` })),
    )}\n\`\`\``;

  it('closes every stage session a completed feature run opens (no idle orphans left in the workspace)', async () => {
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
      workspaceId: 'ws-1',
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
    const { svc, runs, runner, board, boardEvents, openSessions } = build();
    const task = 9;
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      workspaceId: 'ws-2',
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

    // The orchestrator can't orchestrate blind: a terminal failure WAKES Atlas (run-failed event)…
    const failed = boardEvents.emit.mock.calls
      .map((c) => c[0] as { kind: string; taskId: number; reason: string })
      .find((e) => e.kind === 'run-failed');
    expect(failed).toBeDefined();
    expect(failed!.taskId).toBe(task);
    expect(failed!.reason).toMatch(/failed/i);
    // …and the orphaned ticket is reset to 'open' so it's immediately re-dispatchable (no hand-reset).
    expect(board.update).toHaveBeenCalledWith(TEAM, task, { status: 'open' });
  });

  it('reclaims the session when the terminal PR ship fails', async () => {
    const { svc, runs, openSessions } = build({ shipOk: false });
    const task = 11;
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      workspaceId: 'ws-3',
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
