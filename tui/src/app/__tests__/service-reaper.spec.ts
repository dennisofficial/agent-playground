import { afterEach, describe, expect, it } from 'bun:test';
import { EServiceStatus, type ServiceEntry } from '../../domain/services.js';
import {
  installReaperHandlers,
  REAP_SIGNALS,
  reapGracefully,
  reapNow,
  type ReaperTarget,
} from '../service-reaper.js';
import { ServiceRegistryService } from '../service-registry.service.js';
import {
  alive,
  DEAF,
  jobTracker,
  startService,
  waitFor,
} from './real-process.fixture.js';

/**
 * Against REAL process groups, like `service-registry.spec.ts` and for the same reason: every claim
 * here is an operating-system fact, and a mocked `process.kill` would assert only that a mock was
 * called. The one thing NOT driven for real is the re-raise at the end of a signal handler — see
 * `terminate` below, which is injected precisely so this suite cannot kill its own runner.
 */

const jobs = jobTracker('spec-reaper');
const cleanups: Array<() => void> = [];

const newJob = jobs.newJob;

afterEach(() => {
  for (const disarm of cleanups.splice(0)) disarm();
  jobs.cleanup();
});

describe('reapGracefully', () => {
  it('asks with SIGTERM and lets a well-behaved service go on its own', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: 'sleep 30' });

    await reapGracefully({ target: registry, warn: () => {}, graceMs: 100 });

    expect(alive(entry.pid)).toBe(false);
  });

  /**
   * The escalation, and the whole reason the grace exists. A service that ignores SIGTERM — a shell
   * with `trap "" TERM`, or any process whose own shutdown hangs — would otherwise survive the app
   * that started it, which is the one thing this facility promises cannot happen.
   */
  it('insists with SIGKILL on a group that ignored the ask', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: DEAF });

    // Still there after a SIGTERM it was built to ignore — otherwise the assertion below proves
    // nothing about the escalation.
    registry.reapAll({ signal: 'SIGTERM' });
    await Bun.sleep(150);
    expect(alive(entry.pid)).toBe(true);

    await reapGracefully({ target: registry, warn: () => {}, graceMs: 150 });

    await waitFor(() => !alive(entry.pid), 'the deaf group to be killed');
  });

  it('does not wait around when there is nothing to reap', async () => {
    const registry = new ServiceRegistryService();
    const started = Date.now();

    await reapGracefully({ target: registry, warn: () => {}, graceMs: 5_000 });

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('reapNow — the exit backstop', () => {
  /**
   * The load-bearing case, and the one a `status === running` sweep gets wrong.
   *
   * By the time `exit` fires, a graceful reap has already moved every service to `killed` — that is
   * what having signalled it means — while the process may be very much alive. Sweeping `running`
   * would find nothing on exactly the exit path this layer exists to back up, so the question it
   * asks is whether the exit was ever OBSERVED.
   */
  it('kills a group already recorded as killed but never seen to die', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: DEAF });

    registry.reapAll({ signal: 'SIGTERM' });
    await Bun.sleep(150);
    expect(entry.status).toBe(EServiceStatus.killed);
    expect(alive(entry.pid)).toBe(true);

    reapNow({ target: registry, warn: () => {} });

    await waitFor(() => !alive(entry.pid), 'the surviving group to be killed on exit');
  });

  /** Nothing is signalled for a process whose exit landed — its pid belongs to the kernel now. */
  it('leaves a service whose exit has actually been seen alone', () => {
    const warnings: string[] = [];
    const entry = deadEntry();
    reapNow({ target: fakeTarget([entry]), warn: (message) => warnings.push(message) });
    expect(warnings).toEqual([]);
  });

  /** Inside an `exit` handler there is nobody left to report to, and a throw drops the rest. */
  it('never throws, whatever the registry hands it', () => {
    const warnings: string[] = [];
    // Signalled, never seen to die, and carrying a group id that cannot be signalled — the shape a
    // stale mirror has. It must reach the kill (and therefore the throw) rather than being skipped.
    const poisoned: ServiceEntry = liveEntry({ status: EServiceStatus.killed, pgid: -5 });

    expect(() =>
      reapNow({ target: fakeTarget([poisoned]), warn: (message) => warnings.push(message) }),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
  });
});

describe('installReaperHandlers', () => {
  it('claims the three catchable death signals and the exit backstop', () => {
    const before = counts();
    cleanups.push(
      installReaperHandlers({ target: fakeTarget([]), warn: () => {} }).disarmAll,
    );

    for (const signal of REAP_SIGNALS) {
      expect(process.listenerCount(signal)).toBe((before.get(signal) ?? 0) + 1);
    }
    expect(process.listenerCount('exit')).toBe((before.get('exit') ?? 0) + 1);
  });

  it('gives every listener back, so nothing accumulates across a restart', () => {
    const before = counts();
    const handles = installReaperHandlers({ target: fakeTarget([]), warn: () => {} });
    handles.disarmAll();
    // Twice, because a quit path calls it and then the signal handler calls it again.
    handles.disarmAll();

    for (const [event, count] of before) {
      expect(process.listenerCount(event)).toBe(count);
    }
  });

  /**
   * The window this used to leave open, and the reason the disarm is two verbs.
   *
   * `main.tsx` `void`s `context.close()`, so the process can reach `exit` while `reapGracefully` is
   * still sleeping between its SIGTERM and its SIGKILL — the one moment when every service has been
   * signalled and not one is confirmed dead. Dropping the exit handler up front, as the old single
   * uninstall did, meant nothing at all was armed just then.
   */
  it('keeps the exit backstop armed while the grace is still running', async () => {
    const entry = liveEntry();
    const exitBefore = process.listenerCount('exit');
    const sigtermBefore = process.listenerCount('SIGTERM');

    const handles = installReaperHandlers({
      target: { allServices: () => [entry], reapAll: () => [entry] },
      warn: () => {},
      graceMs: 60,
      terminate: () => {},
    });
    cleanups.push(handles.disarmAll);

    const [handler] = process.listeners('SIGTERM').slice(-1);
    (handler as () => void)();

    // Sampled INSIDE the grace, which is the only moment the two disarms can be told apart.
    await Bun.sleep(20);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    expect(process.listenerCount('exit')).toBe(exitBefore + 1);

    // And it does come off once the reap is finished, or a restart accumulates listeners.
    await waitFor(
      () => process.listenerCount('exit') === exitBefore,
      'the backstop to come off after the reap',
    );
  });

  /**
   * Order matters more than it looks: the handler must be OFF the process before it starts reaping,
   * so a second ctrl+c reaches the default disposition and kills Atlas outright rather than queueing
   * behind a reap that is stuck. `terminate` is the port that ends the process, injected here so the
   * assertion does not take the test runner with it.
   */
  it('uninstalls before it reaps, then re-raises the signal it caught', async () => {
    const entry = liveEntry();
    const target = fakeTarget([entry]);
    const armed: boolean[] = [];
    const terminated: NodeJS.Signals[] = [];
    const before = process.listenerCount('SIGTERM');

    cleanups.push(
      installReaperHandlers({
        target: {
          allServices: () => target.allServices(),
          reapAll: (args) => {
            armed.push(process.listenerCount('SIGTERM') > before);
            return target.reapAll(args);
          },
        },
        warn: () => {},
        graceMs: 1,
        terminate: (signal) => terminated.push(signal),
      }).disarmAll,
    );

    const [handler] = process.listeners('SIGTERM').slice(-1);
    (handler as () => void)();
    await waitFor(() => terminated.length > 0, 'the signal to be re-raised');

    expect(armed).toEqual([false]);
    expect(terminated).toEqual(['SIGTERM']);
  });
});

function counts(): Map<NodeJS.Signals | 'exit', number> {
  const events: Array<NodeJS.Signals | 'exit'> = [...REAP_SIGNALS, 'exit'];
  return new Map(events.map((event) => [event, process.listenerCount(event)]));
}

function liveEntry(overrides: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'svc-1',
    jobId: 'job-1',
    command: 'pnpm dev',
    description: 'web dev server',
    cwd: '/repo',
    // Past the kernel's range, so a stray signal from a broken test reaches nothing real.
    pid: 4_194_303,
    pgid: 4_194_303,
    logPath: '/tmp/svc-1.log',
    startedAt: 0,
    status: EServiceStatus.running,
    ...overrides,
  };
}

function deadEntry(): ServiceEntry {
  return liveEntry({ status: EServiceStatus.exited, exitCode: 0, pgid: -5 });
}

function fakeTarget(entries: ServiceEntry[]): ReaperTarget {
  return {
    allServices: () => entries,
    reapAll: () => {
      const signalled = entries.filter((entry) => entry.status === EServiceStatus.running);
      for (const entry of signalled) entry.status = EServiceStatus.killed;
      return signalled;
    },
  };
}
