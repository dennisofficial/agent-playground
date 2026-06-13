import type { Capability, LifecycleCapability } from '../employees/capability';
import type { EmployeeContext } from '../employees/employee-context';
import type { EmployeeDefinition } from '../employees/employee.types';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import type { EngineSpec } from '../engines/engine-spec';
import type { LifecycleHandler } from './lifecycle.handler';
import { LifecycleRunner } from './lifecycle.runner';
import {
  LifecycleEvent,
  type LifecyclePayloads,
  type PlanFinishedPayload,
} from './lifecycle.types';

/**
 * The lifecycle runner in isolation: ordering, typed matcher, blocking transform + the per-event
 * transform contract, async fire-and-forget, timeout, error-isolation, abort, and the membership
 * gate (an employee that doesn't declare the hook is untouched). PersonaService and real handlers
 * are faked.
 */

const CTX: EmployeeContext = { team: 'team frame', roster: 'Alex — backend' };
const provider = { context: () => CTX };

const SPEC: EngineSpec = {
  engine: EWorkerEngineName.CLAUDE,
  systemPrompt: 'sp',
};

/** A fake employee whose `capabilities()` returns the given list. */
const employeeWith = (caps: Capability[]): EmployeeDefinition =>
  ({ id: 'alex', capabilities: () => caps }) as unknown as EmployeeDefinition;

const lifecycleCap = (
  name: string,
  opts: Partial<LifecycleCapability['trigger']> &
    Pick<LifecycleCapability, 'matcher'> = {},
): LifecycleCapability => ({
  name,
  spec: () => SPEC,
  matcher: opts.matcher,
  trigger: {
    kind: 'lifecycle',
    on: LifecycleEvent.PlanFinished,
    mode: opts.mode ?? 'blocking',
    order: opts.order,
    timeoutMs: opts.timeoutMs,
  },
});

const payloadFor = (
  employee: EmployeeDefinition,
  over: Partial<PlanFinishedPayload> = {},
): PlanFinishedPayload => ({
  employee,
  session: { id: 's1' } as PlanFinishedPayload['session'],
  planBody: 'original',
  engineSessionId: 'eng-0',
  worktreePath: '/wt',
  keys: {},
  signal: new AbortController().signal,
  ...over,
});

/** A handler that records invocation and returns a partial. */
const handlerFor = (
  capability: string,
  impl: LifecycleHandler['handle'],
): LifecycleHandler => ({ capability, handle: impl });

const runnerWith = (handlers: LifecycleHandler[]) =>
  new LifecycleRunner(provider, handlers);

describe('LifecycleRunner', () => {
  it('returns the payload unchanged when the employee declares no hook for the event (membership gate)', async () => {
    const runner = runnerWith([
      handlerFor('self_review', async () => ({ planBody: 'should not run' })),
    ]);
    const emp = employeeWith([]); // no capabilities
    const out = await runner.run(
      LifecycleEvent.PlanFinished,
      payloadFor(emp),
    );
    expect(out.planBody).toBe('original');
  });

  it('runs a blocking hook as a transform and replaces only contract-allowed fields', async () => {
    const runner = runnerWith([
      handlerFor('self_review', async () => ({
        planBody: 'revised',
        engineSessionId: 'eng-1',
        // not in the contract — must be ignored:
        worktreePath: '/hacked',
      })),
    ]);
    const emp = employeeWith([lifecycleCap('self_review')]);
    const out = await runner.run(LifecycleEvent.PlanFinished, payloadFor(emp));
    expect(out.planBody).toBe('revised');
    expect(out.engineSessionId).toBe('eng-1');
    expect(out.worktreePath).toBe('/wt'); // unchanged — contract enforced
  });

  it('chains blocking hooks in order, threading the transformed payload', async () => {
    const seen: string[] = [];
    const runner = runnerWith([
      handlerFor('a', async (_e, p) => {
        seen.push(`a:${p.planBody}`);
        return { planBody: `${p.planBody}+a` };
      }),
      handlerFor('b', async (_e, p) => {
        seen.push(`b:${p.planBody}`);
        return { planBody: `${p.planBody}+b` };
      }),
    ]);
    const emp = employeeWith([
      lifecycleCap('b', { order: 2 }),
      lifecycleCap('a', { order: 1 }),
    ]);
    const out = await runner.run(LifecycleEvent.PlanFinished, payloadFor(emp));
    expect(seen).toEqual(['a:original', 'b:original+a']);
    expect(out.planBody).toBe('original+a+b');
  });

  it('skips a hook whose matcher returns false', async () => {
    const runner = runnerWith([
      handlerFor('self_review', async () => ({ planBody: 'revised' })),
    ]);
    const emp = employeeWith([
      lifecycleCap('self_review', { matcher: (p) => p.planBody === 'never' }),
    ]);
    const out = await runner.run(LifecycleEvent.PlanFinished, payloadFor(emp));
    expect(out.planBody).toBe('original');
  });

  it('isolates a throwing blocking hook — keeps the prior payload', async () => {
    const runner = runnerWith([
      handlerFor('boom', async () => {
        throw new Error('kaboom');
      }),
      handlerFor('ok', async (_e, p) => ({ planBody: `${p.planBody}+ok` })),
    ]);
    const emp = employeeWith([
      lifecycleCap('boom', { order: 1 }),
      lifecycleCap('ok', { order: 2 }),
    ]);
    const out = await runner.run(LifecycleEvent.PlanFinished, payloadFor(emp));
    expect(out.planBody).toBe('original+ok'); // boom isolated, ok still ran
  });

  it('times out a slow blocking hook and falls back', async () => {
    const runner = runnerWith([
      handlerFor(
        'slow',
        () => new Promise((resolve) => setTimeout(() => resolve({ planBody: 'late' }), 50)),
      ),
    ]);
    const emp = employeeWith([lifecycleCap('slow', { timeoutMs: 5 })]);
    const out = await runner.run(LifecycleEvent.PlanFinished, payloadFor(emp));
    expect(out.planBody).toBe('original');
  });

  it('stops the chain when the signal is already aborted', async () => {
    let ran = false;
    const runner = runnerWith([
      handlerFor('self_review', async () => {
        ran = true;
        return { planBody: 'revised' };
      }),
    ]);
    const ac = new AbortController();
    ac.abort();
    const emp = employeeWith([lifecycleCap('self_review')]);
    const out = await runner.run(
      LifecycleEvent.PlanFinished,
      payloadFor(emp, { signal: ac.signal }),
    );
    expect(ran).toBe(false);
    expect(out.planBody).toBe('original');
  });

  it('does not let an async hook block or transform the payload', async () => {
    let ran = false;
    const runner = runnerWith([
      handlerFor('notify', async () => {
        ran = true;
        return { planBody: 'should be ignored' };
      }),
    ]);
    const emp = employeeWith([lifecycleCap('notify', { mode: 'async' })]);
    const out = await runner.run(LifecycleEvent.PlanFinished, payloadFor(emp));
    expect(out.planBody).toBe('original'); // async return ignored
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(true); // but it did fire
  });

  it('rejects duplicate handlers for the same capability at construction', () => {
    expect(() =>
      runnerWith([
        handlerFor('dup', async () => undefined),
        handlerFor('dup', async () => undefined),
      ]),
    ).toThrow(/Duplicate LifecycleHandler/);
  });
});

// Type-level: the payload map is exhaustive for wired events.
const _assertPayload: LifecyclePayloads[LifecycleEvent.PlanFinished] =
  null as unknown as PlanFinishedPayload;
void _assertPayload;
