import type { EnvService } from '@core/config/env/env.service';
import type { EngineRegistry } from '../engines/engine.registry';
import type { RunWorkerArgs, WorkerEngine } from '../engines/worker-engine.port';
import type { EmployeeRegistry } from '../employees/employee.registry';
import type { PersonaService } from '../employees/persona.service';
import type { WorklogStore } from '../memory/worklog-store';
import { InMemoryJobRegistry } from './in-memory-job.registry';
import type { Job } from './job-registry.port';
import { statusFromReport, WorkerService } from './worker.service';

const ALEX = { id: 'alex', name: 'Alex', role: 'backend engineer', sortOrder: 10, roleContext: 'x', engine: 'claude' as const };

function buildWorker(engine: WorkerEngine) {
  const jobs = new InMemoryJobRegistry();
  const engines = { get: () => engine } as unknown as EngineRegistry;
  const employees = {
    byId: () => ALEX,
    fallbackOwner: () => ALEX,
    resolveWorkerModel: () => ({ model: 'test-model', effort: 'high' as const }),
  } as unknown as EmployeeRegistry;
  const persona = { workerPromptFor: () => 'worker prompt' } as unknown as PersonaService;
  const worklogged: unknown[] = [];
  const worklog = { logWork: async (e: unknown) => void worklogged.push(e) } as unknown as WorklogStore;
  const env = { get: (k: string) => (k === 'WORKER_ROOT' ? '/tmp/worker-root' : undefined) } as unknown as EnvService;
  const worker = new WorkerService(jobs, engines, employees, persona, worklog, env);
  return { worker, jobs, worklogged };
}

describe('statusFromReport', () => {
  it('treats DONE / PROGRESS / no status as done', () => {
    expect(statusFromReport('All finished.\nSTATUS: DONE')).toBe('done');
    expect(statusFromReport('Some progress.\nSTATUS: PROGRESS halfway')).toBe('done');
    expect(statusFromReport('no status line at all')).toBe('done');
  });

  it('parks QUESTION / BLOCKED as awaiting, reading only the tail', () => {
    expect(statusFromReport('Plan ready.\nSTATUS: QUESTION ready for approval')).toBe('awaiting');
    expect(statusFromReport('Stuck.\nSTATUS: BLOCKED need credentials')).toBe('awaiting');
    // A body that MENTIONS "STATUS: QUESTION" far above the tail must not count.
    const body = `The codebase greps for STATUS: QUESTION in worker.ts.\n${'filler\n'.repeat(10)}STATUS: DONE`;
    expect(statusFromReport(body)).toBe('done');
  });
});

describe('WorkerService (fake engine, no LLM)', () => {
  it('runs dispatch → progress events → done + worklog + onUpdate', async () => {
    const fake: WorkerEngine = {
      name: 'claude',
      async run({ onEvent }: RunWorkerArgs) {
        onEvent({ kind: 'text', text: 'exploring' });
        onEvent({ kind: 'tool', name: 'Read', detail: 'src/index.ts' });
        const result = 'Found it.\nSTATUS: DONE';
        onEvent({ kind: 'result', text: result });
        return { result, sessionId: 'sess-1' };
      },
    };
    const { worker, jobs, worklogged } = buildWorker(fake);

    const updates: Array<[string, string]> = [];
    jobs.onUpdate((j: Job) => updates.push([j.id, j.status]));

    const job = await jobs.create({
      task: 'find the thing',
      notifyThread: 'tui:main',
      engine: 'claude',
      ownerBot: 'alex',
      project: 'local',
      mode: 'plan',
    });
    await worker.runWorkerTurn(job.id, job.task);

    const after = await jobs.get(job.id);
    expect(after?.status).toBe('done');
    expect(after?.sessionId).toBe('sess-1');
    expect(after?.result).toContain('Found it.');
    expect(after?.turns).toBe(1);
    expect((await jobs.progress(job.id)).map((e) => e.kind)).toEqual(['text', 'tool', 'result']);
    expect(worklogged).toHaveLength(1);
    // create → running, runWorkerTurn → done
    expect(updates).toEqual([
      [job.id, 'running'],
      [job.id, 'done'],
    ]);
  });

  it('parks an awaiting report and resumes it via continueWork', async () => {
    let calls = 0;
    const fake: WorkerEngine = {
      name: 'claude',
      async run({ onEvent }: RunWorkerArgs) {
        calls++;
        const result = calls === 1 ? 'Need input.\nSTATUS: QUESTION which db?' : 'Done now.\nSTATUS: DONE';
        onEvent({ kind: 'result', text: result });
        return { result, sessionId: `sess-${calls}` };
      },
    };
    const { worker, jobs } = buildWorker(fake);
    const job = await jobs.create({
      task: 'plan it',
      notifyThread: 'tui:main',
      engine: 'claude',
      ownerBot: 'alex',
      project: 'local',
      mode: 'plan',
    });
    await worker.runWorkerTurn(job.id, job.task);
    expect((await jobs.get(job.id))?.status).toBe('awaiting');

    const res = await worker.continueWork(job.id, 'use postgres');
    expect(res.ok).toBe(true);
    // continueWork fires the next turn async; wait for it to settle.
    await new Promise((r) => setTimeout(r, 20));
    const after = await jobs.get(job.id);
    expect(after?.status).toBe('done');
    expect(after?.version).toBe(1);
    expect(after?.sessionId).toBe('sess-2');
  });

  it('marks a cancelled run cancelled, not failed, and discards its result', async () => {
    const fake: WorkerEngine = {
      name: 'claude',
      run({ signal }: RunWorkerArgs) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
    const { worker, jobs } = buildWorker(fake);
    const job = await jobs.create({
      task: 'long thing',
      notifyThread: 'tui:main',
      engine: 'claude',
      ownerBot: 'alex',
      project: 'local',
      mode: 'plan',
    });
    const running = worker.runWorkerTurn(job.id, job.task);
    await new Promise((r) => setTimeout(r, 10));
    const res = await worker.cancelJob(job.id);
    expect(res.ok).toBe(true);
    await running;
    expect((await jobs.get(job.id))?.status).toBe('cancelled');
    expect((await jobs.get(job.id))?.result).toBeUndefined();
  });

  it('fails the dispatch loudly when WORKER_ROOT is unset', async () => {
    const fake: WorkerEngine = { name: 'claude', run: async () => ({ result: 'x' }) };
    const { worker, jobs } = buildWorker(fake);
    (worker as unknown as { env: { get: () => undefined } }).env = { get: () => undefined };
    const job = await jobs.create({
      task: 't',
      notifyThread: 'tui:main',
      engine: 'claude',
      ownerBot: 'alex',
      project: 'local',
      mode: 'plan',
    });
    await worker.runWorkerTurn(job.id, job.task);
    const after = await jobs.get(job.id);
    expect(after?.status).toBe('failed');
    expect(after?.error).toContain('WORKER_ROOT');
  });
});
