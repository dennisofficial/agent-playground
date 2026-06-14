import type { EnvService } from '@core/config/env/env.service';
import type { EngineRegistry } from '../engines/engine.registry';
import {
  EWorkerEngineName,
  RunWorkerArgs,
  WorkerEngine,
} from '../engines/worker-engine.port';
import type { EmployeeRegistry } from '../employees/employee.registry';
import { makeEmployee } from '../employees/employee.testing';
import type { PersonaService } from '../employees/persona.service';
import type { LifecycleRunner } from '../lifecycle/lifecycle.runner';
import { LifecycleEvent } from '../lifecycle/lifecycle.types';
import type { CredentialContext } from '../llm-keys/credential-context';
import type { TenantCredentialService } from '../llm-keys/tenant-credential.service';
import type { BoardStatus, BoardStore } from '../memory/board-store';
import type { PlanStore } from '../memory/plan-store';
import type { TeamSettingsStore } from '../memory/team-settings-store';
import type { WorklogStore } from '../memory/worklog-store';
import type { WorktreeService } from '../worktrees/worktree.service';
import { InMemorySessionRegistry } from './in-memory-session.registry';
import type { Session } from './session-registry.port';
import { SessionRunnerService } from './session-runner.service';

const ALEX = makeEmployee({
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
  sortOrder: 10,
});

const WT = {
  id: 'wt-001',
  name: 'work',
  branch: 'agent/alex/wt-001-work',
  baseRef: 'abc',
  path: '/tmp/wt-001-work',
  checkout: '/tmp/wt-001-work',
  ownerBot: 'alex',
  project: 'local',
};

function buildRunner(
  engine: WorkerEngine,
  opts: {
    worktree?: typeof WT | undefined;
    /** The EXECUTION_APPROVAL_MODE dial; legacy tests run un-gated ('off'). */
    approvalMode?: 'all' | 'linked' | 'off';
    /** Board tasks visible to the guard, keyed by id. */
    boardTasks?: Record<number, { status: BoardStatus }>;
    /** The team_settings standup flag (default closed). */
    standupOpen?: boolean;
    /** Make PlanStore.attach reject (the attach-failure path). */
    attachFails?: boolean;
    /** Simulate a `plan.finished` self-review hook transforming the plan body. */
    selfReview?: (planBody: string) => string;
    /** What WorktreeService.refreshFromBase returns (default: a clean refresh). */
    refreshResult?: Awaited<ReturnType<WorktreeService['refreshFromBase']>>;
  } = {},
) {
  const worktree = 'worktree' in opts ? opts.worktree : WT;
  const sessions = new InMemorySessionRegistry();
  const engines = { get: () => engine } as unknown as EngineRegistry;
  const ctx = { team: 'local', roster: 'Alex — backend engineer' };
  const employees = {
    byId: () => ALEX,
    fallbackOwner: () => ALEX,
    context: () => ctx,
  } as unknown as EmployeeRegistry;
  const persona = {
    context: () => ctx,
  } as unknown as PersonaService;
  // Lifecycle double: returns the payload, optionally transforming planBody (the self-review hook).
  const lifecycle = {
    run: async (_event: LifecycleEvent, payload: { planBody: string }) =>
      opts.selfReview
        ? { ...payload, planBody: opts.selfReview(payload.planBody) }
        : payload,
  } as unknown as LifecycleRunner;
  const worklogged: unknown[] = [];
  const worklog = {
    logWork: async (e: unknown) => void worklogged.push(e),
  } as unknown as WorklogStore;
  const refreshCalls: string[] = [];
  const worktrees = {
    get: () => worktree,
    refreshFromBase: async (id: string) => {
      refreshCalls.push(id);
      return opts.refreshResult ?? { refreshed: true, baseBranch: 'main' };
    },
  } as unknown as WorktreeService;
  const creds = {
    resolve: async () => ({}),
  } as unknown as TenantCredentialService;
  const credCtx = {
    run: (_c: unknown, fn: () => unknown) => fn(),
  } as unknown as CredentialContext;
  const board = {
    get: (_team: string, id: number) =>
      Promise.resolve(
        opts.boardTasks?.[id] ? { id, ...opts.boardTasks[id] } : undefined,
      ),
  } as unknown as BoardStore;
  const env = {
    get: () => opts.approvalMode ?? 'off',
  } as unknown as EnvService;
  const attached: Array<Record<string, unknown>> = [];
  const plans = {
    attach: (p: Record<string, unknown>) => {
      if (opts.attachFails) return Promise.reject(new Error('db down'));
      attached.push(p);
      return Promise.resolve(p);
    },
  } as unknown as PlanStore;
  const settings = {
    isStandupOpen: () => Promise.resolve(opts.standupOpen ?? false),
  } as unknown as TeamSettingsStore;
  const runner = new SessionRunnerService(
    sessions,
    engines,
    employees,
    persona,
    lifecycle,
    worklog,
    worktrees,
    creds,
    credCtx,
    board,
    env,
    plans,
    settings,
  );
  return { runner, sessions, worklogged, attached, refreshCalls };
}

const newSession = {
  task: 'find the thing',
  worktreeId: 'wt-001',
  notifyThread: 'tui:main',
  engine: EWorkerEngineName.CLAUDE,
  ownerBot: 'alex',
  team: 'local',
  project: 'local',
  mode: 'plan' as const,
};

describe('SessionRunnerService (fake engine, no LLM)', () => {
  it('runs a turn in the worktree and leaves the session OPEN (idle), with no worklog yet', async () => {
    const seen: Partial<RunWorkerArgs>[] = [];
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      async run(args: RunWorkerArgs) {
        seen.push(args);
        args.onEvent({ kind: 'text', text: 'exploring' });
        args.onEvent({ kind: 'tool', name: 'Read', detail: 'src/index.ts' });
        const result = 'Alex — Found it.';
        args.onEvent({ kind: 'result', text: result });
        return { result, sessionId: 'engine-1' };
      },
    };
    const { runner, sessions, worklogged } = buildRunner(fake);

    const updates: Array<[string, string]> = [];
    sessions.onUpdate((s: Session) => updates.push([s.id, s.status]));

    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);

    const after = await sessions.get(session.id);
    expect(after?.status).toBe('idle'); // open, awaiting the owner — NOT done
    expect(after?.engineSessionId).toBe('engine-1');
    expect(after?.lastReport).toBe('Alex — Found it.');
    expect(after?.turns).toBe(1);
    expect(seen[0]?.cwd).toBe(WT.path); // the turn ran in the worktree, not WORKER_ROOT
    expect(seen[0]?.mode).toBe('plan');
    expect(worklogged).toHaveLength(0); // worklog happens on close, not turn-end
    expect(updates).toEqual([
      [session.id, 'running'],
      [session.id, 'idle'],
    ]);
  });

  it('continues the conversation via replySession, and a mode switch persists into the turn', async () => {
    const modes: string[] = [];
    let calls = 0;
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      async run(args: RunWorkerArgs) {
        calls++;
        modes.push(args.mode);
        return {
          result: calls === 1 ? 'Alex — Here is the plan.' : 'Alex — Built it.',
          sessionId: 'engine-1',
        };
      },
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    expect((await sessions.get(session.id))?.status).toBe('idle');

    // Approving the plan = replying with mode 'execute'.
    const res = await runner.replySession(
      session.id,
      'plan approved — build it',
      'execute',
    );
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    const after = await sessions.get(session.id);
    expect(after?.status).toBe('idle'); // still open for follow-ups
    expect(after?.mode).toBe('execute');
    expect(after?.turns).toBe(2);
    expect(modes).toEqual(['plan', 'execute']);
  });

  it('refuses replySession mid-turn and on a closed session', async () => {
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run({ signal }: RunWorkerArgs) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      },
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    const running = runner.runSessionTurn(session.id, session.task);
    await new Promise((r) => setTimeout(r, 10));

    expect((await runner.replySession(session.id, 'hello?')).ok).toBe(false);
    await runner.closeSession(session.id);
    await running;
    expect((await runner.replySession(session.id, 'hello?')).ok).toBe(false);
  });

  it('closing mid-turn aborts the run, discards its result, and stays closed', async () => {
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run({ signal }: RunWorkerArgs) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      },
    };
    const { runner, sessions, worklogged } = buildRunner(fake);
    const session = await sessions.create(newSession);
    const running = runner.runSessionTurn(session.id, session.task);
    await new Promise((r) => setTimeout(r, 10));
    const res = await runner.closeSession(session.id);
    expect(res.ok).toBe(true);
    await running;
    expect((await sessions.get(session.id))?.status).toBe('closed');
    expect((await sessions.get(session.id))?.lastReport).toBeUndefined();
    expect(worklogged).toHaveLength(0); // nothing reported → nothing to log
  });

  it('logs completed work on close (when the session produced a report)', async () => {
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run: async () => ({ result: 'Alex — Shipped the fix.', sessionId: 'e1' }),
    };
    const { runner, sessions, worklogged } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    await runner.closeSession(session.id);
    expect((await sessions.get(session.id))?.status).toBe('closed');
    expect(worklogged).toEqual([
      {
        team: 'local',
        ownerBot: 'alex',
        project: 'local',
        task: 'find the thing',
        summary: 'Alex — Shipped the fix.',
      },
    ]);
  });

  it('a failed turn leaves the session open, and a reply retries it', async () => {
    let calls = 0;
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      async run() {
        calls++;
        if (calls === 1) throw new Error('engine exploded');
        return { result: 'Alex — Recovered.', sessionId: 'e1' };
      },
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    expect((await sessions.get(session.id))?.status).toBe('failed');
    expect((await sessions.get(session.id))?.error).toContain(
      'engine exploded',
    );

    const res = await runner.replySession(session.id, 'try again');
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect((await sessions.get(session.id))?.status).toBe('idle');
  });

  it('fails the turn loudly when the worktree is gone', async () => {
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run: async () => ({ result: 'x' }),
    };
    const { runner, sessions } = buildRunner(fake, { worktree: undefined });
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    const after = await sessions.get(session.id);
    expect(after?.status).toBe('failed');
    expect(after?.error).toContain('wt-001');
  });

  it('searchTranscript pages the full transcript and finds matching lines', async () => {
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      async run({ onEvent }: RunWorkerArgs) {
        for (let i = 1; i <= 45; i++)
          onEvent({ kind: 'text', text: `step ${i}` });
        onEvent({ kind: 'tool', name: 'Bash', detail: 'pnpm test' });
        return { result: 'done', sessionId: 'e1' };
      },
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);

    const page1 = await runner.searchTranscript(session.id);
    expect(page1).toContain('lines 7–46 of 46');
    expect(page1).toContain('pnpm test');
    const page2 = await runner.searchTranscript(session.id, { page: 2 });
    expect(page2).toContain('lines 1–6 of 46');
    expect(page2).toContain('step 1');

    const hits = await runner.searchTranscript(session.id, { query: 'PNPM' });
    expect(hits).toContain('1 of 46 transcript lines match');
    expect(hits).toContain('→ called Bash (pnpm test)');
  });
});

describe('SessionRunnerService — questions and planning Q&A', () => {
  const QUESTION = {
    question: 'Which auth approach?',
    header: 'Auth',
    options: [
      { label: 'Session cookie', description: 'reuse middleware' },
      { label: 'API token' },
    ],
  };

  it('a turn that asked becomes a questions-report; the answer lands on the Q&A ledger; the finished plan carries the appendix', async () => {
    let calls = 0;
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run() {
        calls++;
        return Promise.resolve(
          calls === 1
            ? {
                result: 'waiting on answers',
                sessionId: 'e1',
                questions: [QUESTION],
              }
            : { result: 'The plan.', sessionId: 'e1', planText: 'The plan.' },
        );
      },
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);

    const asked = await sessions.get(session.id);
    expect(asked?.lastReportKind).toBe('questions');
    expect(asked?.lastReport).toContain('I need answers');
    expect(asked?.lastReport).toContain('Which auth approach?');
    expect(asked?.lastReport).toContain('1. Session cookie — reuse middleware');

    const res = await runner.replySession(
      session.id,
      'Q1: option 1 — cookies, we already have the middleware',
    );
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    const planned = await sessions.get(session.id);
    expect(planned?.qa).toHaveLength(1);
    expect(planned?.qa?.[0]?.a).toContain('option 1');
    expect(planned?.lastReportKind).toBe('plan');
    expect(planned?.lastReport).toContain('The plan.');
    expect(planned?.lastReport).toContain('Decisions made while planning');
    expect(planned?.lastReport).toContain('Which auth approach?');
  });

  it('a questions-turn that ALSO captured a partial plan is still a questions-report', async () => {
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run: () =>
        Promise.resolve({
          result: 'partial',
          sessionId: 'e1',
          questions: [QUESTION],
          planText: 'Half a plan.',
        }),
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    const after = await sessions.get(session.id);
    expect(after?.lastReportKind).toBe('questions');
    expect(after?.lastReport).toContain('Partial plan so far');
    expect(after?.lastReport).toContain('Half a plan.');
  });

  it('an ordinary report clears a stale lastReportKind', async () => {
    let calls = 0;
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run() {
        calls++;
        return Promise.resolve(
          calls === 1
            ? { result: 'x', sessionId: 'e1', questions: [QUESTION] }
            : { result: 'Alex — Just an update.', sessionId: 'e1' },
        );
      },
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    expect((await sessions.get(session.id))?.lastReportKind).toBe('questions');
    await runner.replySession(session.id, 'Q1: your call');
    await new Promise((r) => setTimeout(r, 20));
    const after = await sessions.get(session.id);
    expect(after?.lastReportKind).toBeUndefined();
    expect(after?.lastReport).toBe('Alex — Just an update.');
    expect(after?.qa).toHaveLength(1); // the answer was still recorded
  });
});

describe('SessionRunnerService — the execute-approval gate', () => {
  const echo: WorkerEngine = {
    name: EWorkerEngineName.CLAUDE,
    run: () => Promise.resolve({ result: 'ok', sessionId: 'e1' }),
  };

  async function idleSession(
    runner: SessionRunnerService,
    sessions: InMemorySessionRegistry,
    boardTaskId?: number,
  ) {
    const session = await sessions.create({
      ...newSession,
      ...(boardTaskId !== undefined ? { boardTaskId } : {}),
    });
    await runner.runSessionTurn(session.id, session.task);
    return session;
  }

  it("dial 'all': refuses an execute flip on an UNLINKED session, with directions", async () => {
    const { runner, sessions } = buildRunner(echo, { approvalMode: 'all' });
    const session = await idleSession(runner, sessions);
    const res = await runner.replySession(session.id, 'go', 'execute');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('APPROVED board task');
    expect((await sessions.get(session.id))?.mode).toBe('plan'); // refused flip mutated nothing
  });

  it("dial 'all': linked session is refused until the task is approved, then allowed", async () => {
    const tasks: Record<number, { status: BoardStatus }> = {
      7: { status: 'awaiting_approval' },
    };
    const { runner, sessions } = buildRunner(echo, {
      approvalMode: 'all',
      boardTasks: tasks,
    });
    const session = await idleSession(runner, sessions, 7);

    const refused = await runner.replySession(session.id, 'go', 'execute');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("#7 is 'awaiting_approval'");

    tasks[7] = { status: 'approved' };
    const allowed = await runner.replySession(session.id, 'go', 'execute');
    expect(allowed.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect((await sessions.get(session.id))?.mode).toBe('execute');
  });

  it("dial 'all': a linked task that vanished fails closed", async () => {
    const { runner, sessions } = buildRunner(echo, { approvalMode: 'all' });
    const session = await idleSession(runner, sessions, 99);
    const res = await runner.replySession(session.id, 'go', 'execute');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('#99 no longer exists');
  });

  it("dial 'linked': unlinked sessions stay autonomous; linked ones are still gated", async () => {
    const { runner, sessions } = buildRunner(echo, {
      approvalMode: 'linked',
      boardTasks: { 7: { status: 'planning' } },
    });
    const unlinked = await idleSession(runner, sessions);
    expect((await runner.replySession(unlinked.id, 'go', 'execute')).ok).toBe(
      true,
    );
    const linked = await idleSession(runner, sessions, 7);
    const res = await runner.replySession(linked.id, 'go', 'execute');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("#7 is 'planning'");
  });

  it("dial 'off': nothing is gated", async () => {
    const { runner, sessions } = buildRunner(echo, {
      approvalMode: 'off',
      boardTasks: { 7: { status: 'open' } },
    });
    const linked = await idleSession(runner, sessions, 7);
    expect((await runner.replySession(linked.id, 'go', 'execute')).ok).toBe(
      true,
    );
  });

  it('plan-mode replies are never gated, even on an unapproved linked task', async () => {
    const { runner, sessions } = buildRunner(echo, {
      approvalMode: 'all',
      boardTasks: { 7: { status: 'open' } },
    });
    const session = await idleSession(runner, sessions, 7);
    expect((await runner.replySession(session.id, 'refine', 'plan')).ok).toBe(
      true,
    );
  });

  it("a 'done' task still allows execution (post-approval follow-ups)", async () => {
    const { runner, sessions } = buildRunner(echo, {
      approvalMode: 'all',
      boardTasks: { 7: { status: 'done' } },
    });
    const session = await idleSession(runner, sessions, 7);
    expect((await runner.replySession(session.id, 'go', 'execute')).ok).toBe(
      true,
    );
  });

  it('a ticket in review stays executable through review-fix rounds — even during an open standup', async () => {
    const { runner, sessions } = buildRunner(echo, {
      approvalMode: 'all',
      boardTasks: { 7: { status: 'in_review' } },
      standupOpen: true,
    });
    const session = await idleSession(runner, sessions, 7);
    expect(
      (
        await runner.replySession(
          session.id,
          'fix the review comment',
          'execute',
        )
      ).ok,
    ).toBe(true);
  });

  it('an OPEN standup refuses every execute flip — even an approved linked task, even unlinked', async () => {
    const { runner, sessions } = buildRunner(echo, {
      approvalMode: 'all',
      boardTasks: { 7: { status: 'approved' } },
      standupOpen: true,
    });
    const linked = await idleSession(runner, sessions, 7);
    const refused = await runner.replySession(linked.id, 'go', 'execute');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('standup is still OPEN');

    const unlinkedRunner = buildRunner(echo, {
      approvalMode: 'linked',
      standupOpen: true,
    });
    const unlinked = await idleSession(
      unlinkedRunner.runner,
      unlinkedRunner.sessions,
    );
    const alsoRefused = await unlinkedRunner.runner.replySession(
      unlinked.id,
      'go',
      'execute',
    );
    expect(alsoRefused.ok).toBe(false);
    expect(alsoRefused.reason).toContain('standup');
  });

  it("dial 'off' ignores even an open standup (the documented kill-switch)", async () => {
    const { runner, sessions } = buildRunner(echo, {
      approvalMode: 'off',
      standupOpen: true,
    });
    const session = await idleSession(runner, sessions);
    expect((await runner.replySession(session.id, 'go', 'execute')).ok).toBe(
      true,
    );
  });

  it('plan-mode replies are never standup-gated', async () => {
    const { runner, sessions } = buildRunner(echo, {
      approvalMode: 'all',
      boardTasks: { 7: { status: 'planning' } },
      standupOpen: true,
    });
    const session = await idleSession(runner, sessions, 7);
    expect((await runner.replySession(session.id, 'refine', 'plan')).ok).toBe(
      true,
    );
  });
});

describe('SessionRunnerService — plan relay (no auto-attach) + plan.finished hooks', () => {
  const planEngine = (planText: string): WorkerEngine => ({
    name: EWorkerEngineName.CLAUDE,
    run: () => Promise.resolve({ result: planText, sessionId: 'e1', planText }),
  });

  it('a board-linked plan turn does NOT auto-attach — it relays the plan (incl. Q&A) for the employee to submit', async () => {
    let calls = 0;
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run() {
        calls++;
        return Promise.resolve(
          calls === 1
            ? {
                result: 'asking',
                sessionId: 'e1',
                questions: [
                  { question: 'Which auth?', options: [{ label: 'Cookie' }] },
                ],
              }
            : { result: 'The plan.', sessionId: 'e1', planText: 'The plan.' },
        );
      },
    };
    const { runner, sessions, attached } = buildRunner(fake);
    const session = await sessions.create({ ...newSession, boardTaskId: 7 });
    await runner.runSessionTurn(session.id, session.task);
    await runner.replySession(session.id, 'Q1: option 1');
    await new Promise((r) => setTimeout(r, 20));

    // The runner attaches NOTHING — submit_plan is what attaches (the employee gate).
    expect(attached).toHaveLength(0);
    const after = await sessions.get(session.id);
    expect(after?.lastReportKind).toBe('plan');
    expect(after?.lastReport).toContain('The plan.');
    expect(after?.lastReport).toContain('Decisions made while planning');
  });

  it('an UNLINKED plan turn relays the plan and attaches nothing', async () => {
    const { runner, sessions, attached } = buildRunner(planEngine('A plan.'));
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    expect(attached).toHaveLength(0);
    expect((await sessions.get(session.id))?.lastReport).toContain('A plan.');
  });

  it('applies a plan.finished self-review hook transform to the relayed plan', async () => {
    const { runner, sessions } = buildRunner(planEngine('First draft plan.'), {
      // The lifecycle double stands in for the self-review hook (the handler is tested separately).
      selfReview: () =>
        'Revised plan — now with the migration.\n\n_(self-reviewed by codex before attaching)_',
    });
    const session = await sessions.create({ ...newSession, boardTaskId: 7 });
    await runner.runSessionTurn(session.id, session.task);
    const after = await sessions.get(session.id);
    expect(after?.lastReport).toContain(
      'Revised plan — now with the migration.',
    );
    expect(after?.lastReport).toContain('self-reviewed');
    expect(after?.lastReport).not.toContain('First draft plan.');
  });

  it('a board-linked plan with NO hook relays the un-transformed plan', async () => {
    const { runner, sessions } = buildRunner(planEngine('The only plan.'));
    const session = await sessions.create({ ...newSession, boardTaskId: 7 });
    await runner.runSessionTurn(session.id, session.task);
    expect((await sessions.get(session.id))?.lastReport).toContain(
      'The only plan.',
    );
  });
});

describe('SessionRunnerService — investigate confidence escalation (v2)', () => {
  const investigate = { ...newSession, mode: 'investigate' as const };

  it('re-runs ONCE on the deeper model when an investigate report is LOW confidence, and relays that pass', async () => {
    const models: Array<string | undefined> = [];
    let calls = 0;
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      async run(args: RunWorkerArgs) {
        calls++;
        models.push(args.model);
        return calls === 1
          ? {
              result: 'Alex — partial answer.\nConfidence: low — could not find it.',
              sessionId: 'engine-1',
            }
          : {
              result: 'Alex — deeper answer.\nConfidence: high — verified.',
              sessionId: 'engine-1',
            };
      },
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(investigate);
    await runner.runSessionTurn(session.id, session.task);

    expect(calls).toBe(2);
    expect(models[1]).toBe('claude-opus-4-8'); // the second pass used the escalation model
    expect(models[1]).not.toBe(models[0]);
    const after = await sessions.get(session.id);
    expect(after?.status).toBe('idle');
    expect(after?.lastReport).toContain('deeper answer'); // the escalated pass is what relays
    expect(after?.turns).toBe(1); // still ONE logical turn
  });

  it('does NOT escalate when confidence is not low (or no marker)', async () => {
    let calls = 0;
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      async run() {
        calls++;
        return { result: 'Alex — solid.\nConfidence: high — verified.', sessionId: 'e1' };
      },
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(investigate);
    await runner.runSessionTurn(session.id, session.task);
    expect(calls).toBe(1);
  });

  it('does NOT escalate a non-investigate (plan/execute) turn, even on low confidence', async () => {
    let calls = 0;
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      async run() {
        calls++;
        return { result: 'Alex — plan.\nConfidence: low — unsure.', sessionId: 'e1' };
      },
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession); // mode: 'plan'
    await runner.runSessionTurn(session.id, session.task);
    expect(calls).toBe(1);
  });
});

describe('SessionRunnerService — coherence canary (name-echo check)', () => {
  it('appends the coherence note when a prose-report turn drops the name', async () => {
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run: async () => ({
        result: 'Here is my report, no name prefix.',
        sessionId: 'e1',
      }),
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    const after = await sessions.get(session.id);
    expect(after?.lastReport).toContain('Here is my report, no name prefix.');
    expect(after?.lastReport).toContain('⚠️ Coherence check');
    expect(after?.lastReport).toContain('Alex');
  });

  it('does NOT append the note when the prose report echoes the name', async () => {
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run: async () => ({ result: 'Alex — found the issue.', sessionId: 'e1' }),
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    const after = await sessions.get(session.id);
    expect(after?.lastReport).toBe('Alex — found the issue.');
    expect(after?.lastReport).not.toContain('⚠️');
  });

  it('does NOT append the note on a plan turn (kind=plan)', async () => {
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run: async () => ({
        result: 'No name prefix here.',
        sessionId: 'e1',
        planText: 'No name prefix here.',
      }),
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    const after = await sessions.get(session.id);
    expect(after?.lastReportKind).toBe('plan');
    expect(after?.lastReport).not.toContain('⚠️');
  });

  it('does NOT append the note on a questions turn (kind=questions)', async () => {
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run: async () => ({
        result: 'No name prefix here.',
        sessionId: 'e1',
        questions: [
          { question: 'Which approach?', options: [{ label: 'Option A' }] },
        ],
      }),
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    const after = await sessions.get(session.id);
    expect(after?.lastReportKind).toBe('questions');
    expect(after?.lastReport).not.toContain('⚠️');
  });

  it('does NOT append the note when result is empty (the (no report) fallback)', async () => {
    const fake: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      run: async () => ({ result: '', sessionId: 'e1' }),
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    const after = await sessions.get(session.id);
    expect(after?.lastReport).toBe('(no report)');
    expect(after?.lastReport).not.toContain('⚠️');
  });
});

describe('SessionRunnerService — base refresh on entering execute', () => {
  const execSession = { ...newSession, mode: 'execute' as const };
  const okEngine: WorkerEngine = {
    name: EWorkerEngineName.CLAUDE,
    run: async () => ({ result: 'Alex — done.', sessionId: 'e1' }),
  };

  it('refreshes the worktree when a fresh execute session starts (enteringExecute)', async () => {
    const { runner, sessions, refreshCalls } = buildRunner(okEngine);
    const session = await sessions.create(execSession);
    await runner.runSessionTurn(session.id, session.task, undefined, true);
    expect(refreshCalls).toEqual(['wt-001']);
  });

  it('does NOT refresh on a plan turn', async () => {
    const { runner, sessions, refreshCalls } = buildRunner(okEngine);
    const session = await sessions.create(newSession); // mode 'plan'
    await runner.runSessionTurn(session.id, session.task);
    expect(refreshCalls).toEqual([]);
  });

  it('refreshes on a plan→execute flip via replySession', async () => {
    const { runner, sessions, refreshCalls } = buildRunner(okEngine);
    const session = await sessions.create(newSession); // plan
    await runner.runSessionTurn(session.id, session.task);
    expect(refreshCalls).toEqual([]); // plan turn didn't refresh
    await runner.replySession(session.id, 'approved — build it', 'execute');
    await new Promise((r) => setTimeout(r, 20));
    expect(refreshCalls).toEqual(['wt-001']);
  });

  it('does NOT refresh again on a continuing execute→execute reply', async () => {
    const { runner, sessions, refreshCalls } = buildRunner(okEngine);
    const session = await sessions.create(newSession); // plan
    await runner.runSessionTurn(session.id, session.task);
    await runner.replySession(session.id, 'build it', 'execute'); // flip → refresh #1
    await new Promise((r) => setTimeout(r, 20));
    await runner.replySession(session.id, 'keep going', 'execute'); // execute→execute
    await new Promise((r) => setTimeout(r, 20));
    expect(refreshCalls).toEqual(['wt-001']); // only the flip refreshed
  });

  it('skips the refresh when another session is mid-turn in the same worktree', async () => {
    const { runner, sessions, refreshCalls } = buildRunner(okEngine);
    // A second session on the SAME worktree, left 'running' (create defaults to running).
    await sessions.create(execSession);
    const session = await sessions.create(execSession);
    await runner.runSessionTurn(session.id, session.task, undefined, true);
    expect(refreshCalls).toEqual([]);
  });

  it('hands a base-merge conflict to the engine as the first act of the turn', async () => {
    const seen: Partial<RunWorkerArgs>[] = [];
    const recording: WorkerEngine = {
      name: EWorkerEngineName.CLAUDE,
      async run(args: RunWorkerArgs) {
        seen.push(args);
        return { result: 'Alex — resolved.', sessionId: 'e1' };
      },
    };
    const { runner, sessions } = buildRunner(recording, {
      refreshResult: {
        refreshed: false,
        conflicted: true,
        baseBranch: 'main',
        files: ['src/app.ts'],
      },
    });
    const session = await sessions.create(execSession);
    await runner.runSessionTurn(session.id, 'do the work', undefined, true);
    expect(seen[0]?.task).toMatch(/IN PROGRESS/);
    expect(seen[0]?.task).toContain('main');
    expect(seen[0]?.task).toContain('src/app.ts');
    expect(seen[0]?.task).toContain('do the work'); // original task still there
  });
});
