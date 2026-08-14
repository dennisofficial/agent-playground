import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { jobDir } from '../../domain/paths.js';
import {
  EServiceStatus,
  mayStillBeAlive,
  type ServiceEntry,
} from '../../domain/services.js';
import { killGroup } from '../service-process.js';
import {
  installReaperHandlers,
  REAP_SIGNALS,
  reapGracefully,
  reapNow,
  type ReaperTarget,
} from '../service-reaper.js';
import { ServiceRegistryService } from '../service-registry.service.js';

/**
 * Against REAL process groups, like `service-registry.spec.ts` and for the same reason: every claim
 * here is an operating-system fact, and a mocked `process.kill` would assert only that a mock was
 * called. The one thing NOT driven for real is the re-raise at the end of a signal handler — see
 * `terminate` below, which is injected precisely so this suite cannot kill its own runner.
 */

const created: string[] = [];
const cleanups: Array<() => void> = [];

function newJob(): string {
  const jobId = `spec-reaper-${randomUUID()}`;
  created.push(jobId);
  return jobId;
}

afterEach(() => {
  for (const disarm of cleanups.splice(0)) disarm();
  for (const jobId of created.splice(0)) {
    rmSync(jobDir(jobId), { recursive: true, force: true });
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A shell that ignores SIGTERM outright, and keeps a live child so the group is never empty. */
const DEAF = 'trap "" TERM; while true; do sleep 0.2; done';

async function startService(args: {
  registry: ServiceRegistryService;
  jobId: string;
  command: string;
}): Promise<ServiceEntry> {
  await args.registry.start({
    jobId: args.jobId,
    command: args.command,
    description: 'a service',
    cwd: tmpdir(),
  });
  const entries = args.registry.listFor(args.jobId);
  const entry = entries[entries.length - 1];
  if (!entry) throw new Error('no entry recorded');
  return entry;
}

describe('reapAll', () => {
  it('kills every job by group, not just the one in front of the user', async () => {
    const registry = new ServiceRegistryService();
    const first = newJob();
    const second = newJob();
    const a = await startService({ registry, jobId: first, command: 'sleep 30' });
    const b = await startService({ registry, jobId: second, command: 'sleep 30' });

    expect(registry.reapAll({ signal: 'SIGTERM' })).toHaveLength(2);

    await waitFor(() => !alive(a.pid) && !alive(b.pid), 'both groups to die');
    expect(a.status).toBe(EServiceStatus.killed);
    expect(b.status).toBe(EServiceStatus.killed);
  });

  /**
   * The jobs stay in the map, unlike `reapJob`'s deletion. Atlas is going away, not forgetting these
   * jobs — and the exit backstop, which runs after this, has to still be able to see them.
   */
  it('keeps the rows so the backstop still has something to sweep', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    await startService({ registry, jobId, command: 'sleep 30' });

    registry.reapAll({ signal: 'SIGTERM' });

    expect(registry.listFor(jobId)).toHaveLength(1);
    expect(registry.allServices()).toHaveLength(1);
  });

  it('is idempotent — a second sweep finds nothing left to signal', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: 'sleep 30' });

    expect(registry.reapAll({ signal: 'SIGTERM' })).toHaveLength(1);
    // Once its exit has actually landed there is nothing left to signal. Waiting for the code rather
    // than sweeping straight away is the honest test: in the millisecond between the signal and the
    // death this service IS still there, and a sweep that skipped it then would be the leak below.
    await waitFor(() => entry.exitCode !== undefined, 'the exit to land');
    expect(registry.reapAll({ signal: 'SIGTERM' })).toEqual([]);
  });

  /**
   * The service that survives a sweep keyed on `running`, and the reason both sweeps ask
   * `mayStillBeAlive` instead.
   *
   * `stop` records `killed` on signal DELIVERY. Press `k` on a group that traps SIGTERM and it is
   * `killed` in memory, up, and holding its port — and a quit that skipped it would leave it running
   * after Atlas was gone, which is the one promise this slice makes.
   */
  it('signals a group that was stopped by hand and ignored it', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: DEAF });

    try {
      await registry.stop({ jobId, id: entry.id });
      expect(entry.status).toBe(EServiceStatus.killed);
      expect(alive(entry.pid)).toBe(true);

      expect(registry.reapAll({ signal: 'SIGKILL' })).toEqual([entry]);
      await waitFor(() => !alive(entry.pid), 'the stubborn group to die');
    } finally {
      // A SIGTERM-immune busy loop outlives the runner if an assertion above throws first.
      killGroup({ pgid: entry.pgid, signal: 'SIGKILL' });
    }
  });

  /**
   * The same skip in `reapJob`, where it is unrecoverable — and where the escalation is not optional.
   *
   * This sweep FORGETS the job at the end, so it is the LAST layer that will ever hold this pgid: a
   * group it merely re-asks is orphaned and unrecorded at once, and no backstop can find it again.
   * `reapGracefully` can afford to SIGTERM and come back in 300 ms because it runs again; this one
   * gets no second pass, so a service that has already been asked once must be insisted on NOW.
   */
  it('reapJob SIGKILLs a group that already ignored its SIGTERM', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: DEAF });

    try {
      await registry.stop({ jobId, id: entry.id });
      expect(alive(entry.pid)).toBe(true);

      expect(registry.reapJob(jobId)).toEqual([entry.id]);
      expect(registry.listFor(jobId)).toHaveLength(0);
      // The point of the whole test: forgetting it is only safe because it is genuinely dead.
      await waitFor(() => !alive(entry.pid), 'the forgotten group to be dead');
    } finally {
      killGroup({ pgid: entry.pgid, signal: 'SIGKILL' });
    }
  });

  /**
   * A group that is already gone answers `ESRCH`, which is not a failure — it is the answer. It must
   * not throw, and it must not be recorded as a kill Atlas made.
   */
  it('swallows a group that has already gone, without claiming credit for it', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: 'sleep 30' });
    // Past the kernel's pid range: what a stale mirror looks like, and the only way to reach the
    // ESRCH branch without racing the exit watcher.
    const realPid = entry.pid;
    entry.pgid = 4_194_303;

    expect(registry.reapAll({ signal: 'SIGTERM' })).toEqual([]);
    // `exited`, not `running`: the kernel has just said this group does not exist, and leaving the
    // row `running` both re-signals it from the exit backstop and hands the deferred reconcile a
    // live-looking pgid that the kernel is free to reissue to a stranger.
    expect(entry.status).toBe(EServiceStatus.exited);
    expect(mayStillBeAlive(entry)).toBe(false);

    process.kill(-realPid, 'SIGKILL');
  });

  /**
   * Best-effort, and for a harder reason than `reapJob`'s: this runs on the way out of the process,
   * where one unsignallable group aborting the loop leaks every service after it in the map.
   */
  it('carries on past a group it cannot signal at all', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const bad = await startService({ registry, jobId, command: 'sleep 30' });
    const good = await startService({ registry, jobId, command: 'sleep 30' });
    const realPid = bad.pid;
    // `-5` rather than the more realistic `0`: `killGroup`'s floor is what stops `0` meaning "my own
    // process group", and a test relying on that floor would SIGTERM the runner the day it is
    // deleted. `-5` throws with the floor and without it.
    bad.pgid = -5;

    expect(registry.reapAll({ signal: 'SIGTERM' })).toEqual([good]);
    await waitFor(() => !alive(good.pid), 'the second group to die');

    process.kill(-realPid, 'SIGKILL');
  });
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
