import type { EngineRegistry } from '../engines/engine.registry';
import type {
  RunWorkerArgs,
  WorkerEngine,
} from '../engines/worker-engine.port';
import type { EmployeeRegistry } from '../employees/employee.registry';
import type { PersonaService } from '../employees/persona.service';
import type { WorklogStore } from '../memory/worklog-store';
import type { WorktreeService } from '../worktrees/worktree.service';
import { InMemorySessionRegistry } from './in-memory-session.registry';
import type { Session } from './session-registry.port';
import { SessionRunnerService } from './session-runner.service';

const ALEX = {
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
  sortOrder: 10,
  roleContext: 'x',
  engine: 'claude' as const,
};

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

function buildRunner(engine: WorkerEngine, opts: { worktree?: typeof WT | undefined } = { worktree: WT }) {
  const sessions = new InMemorySessionRegistry();
  const engines = { get: () => engine } as unknown as EngineRegistry;
  const employees = {
    byId: () => ALEX,
    fallbackOwner: () => ALEX,
    resolveWorkerModel: (_bot: unknown, mode: string) => ({
      model: mode === 'plan' ? 'plan-model' : 'exec-model',
      effort: 'high' as const,
    }),
  } as unknown as EmployeeRegistry;
  const persona = {
    workerPromptFor: () => 'worker prompt',
  } as unknown as PersonaService;
  const worklogged: unknown[] = [];
  const worklog = {
    logWork: async (e: unknown) => void worklogged.push(e),
  } as unknown as WorklogStore;
  const worktrees = {
    get: () => opts.worktree,
  } as unknown as WorktreeService;
  const runner = new SessionRunnerService(
    sessions,
    engines,
    employees,
    persona,
    worklog,
    worktrees,
  );
  return { runner, sessions, worklogged };
}

const newSession = {
  task: 'find the thing',
  worktreeId: 'wt-001',
  notifyThread: 'tui:main',
  engine: 'claude' as const,
  ownerBot: 'alex',
  project: 'local',
  mode: 'plan' as const,
};

describe('SessionRunnerService (fake engine, no LLM)', () => {
  it('runs a turn in the worktree and leaves the session OPEN (idle), with no worklog yet', async () => {
    const seen: Partial<RunWorkerArgs>[] = [];
    const fake: WorkerEngine = {
      name: 'claude',
      async run(args: RunWorkerArgs) {
        seen.push(args);
        args.onEvent({ kind: 'text', text: 'exploring' });
        args.onEvent({ kind: 'tool', name: 'Read', detail: 'src/index.ts' });
        const result = 'Found it.';
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
    expect(after?.lastReport).toBe('Found it.');
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
      name: 'claude',
      async run(args: RunWorkerArgs) {
        calls++;
        modes.push(args.mode);
        return {
          result: calls === 1 ? 'Here is the plan.' : 'Built it.',
          sessionId: 'engine-1',
        };
      },
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    expect((await sessions.get(session.id))?.status).toBe('idle');

    // Approving the plan = replying with mode 'execute'.
    const res = await runner.replySession(session.id, 'plan approved — build it', 'execute');
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
      name: 'claude',
      run({ signal }: RunWorkerArgs) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
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
      name: 'claude',
      run({ signal }: RunWorkerArgs) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
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
      name: 'claude',
      run: async () => ({ result: 'Shipped the fix.', sessionId: 'e1' }),
    };
    const { runner, sessions, worklogged } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    await runner.closeSession(session.id);
    expect((await sessions.get(session.id))?.status).toBe('closed');
    expect(worklogged).toEqual([
      {
        ownerBot: 'alex',
        project: 'local',
        task: 'find the thing',
        summary: 'Shipped the fix.',
      },
    ]);
  });

  it('a failed turn leaves the session open, and a reply retries it', async () => {
    let calls = 0;
    const fake: WorkerEngine = {
      name: 'claude',
      async run() {
        calls++;
        if (calls === 1) throw new Error('engine exploded');
        return { result: 'Recovered.', sessionId: 'e1' };
      },
    };
    const { runner, sessions } = buildRunner(fake);
    const session = await sessions.create(newSession);
    await runner.runSessionTurn(session.id, session.task);
    expect((await sessions.get(session.id))?.status).toBe('failed');
    expect((await sessions.get(session.id))?.error).toContain('engine exploded');

    const res = await runner.replySession(session.id, 'try again');
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect((await sessions.get(session.id))?.status).toBe('idle');
  });

  it('fails the turn loudly when the worktree is gone', async () => {
    const fake: WorkerEngine = {
      name: 'claude',
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
      name: 'claude',
      async run({ onEvent }: RunWorkerArgs) {
        for (let i = 1; i <= 45; i++) onEvent({ kind: 'text', text: `step ${i}` });
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
