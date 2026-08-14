import { afterEach, describe, expect, it } from 'bun:test';
import {
  EServiceStatus,
  mayStillBeAlive,
} from '../../domain/services.js';
import { killGroup } from '../service-process.js';
import { reapGracefully } from '../service-reaper.js';
import { ServiceRegistryService } from '../service-registry.service.js';
import {
  alive,
  DEAF,
  jobTracker,
  startService,
  waitFor,
} from './real-process.fixture.js';

/**
 * The two sweeps in `service-reap.ts`, against REAL process groups.
 *
 * Everything here is an operating-system claim — a deaf group survives a SIGTERM, `reapJob` has to
 * insist because it forgets the job, an orphan mid-grace must still be reachable to a quit — and
 * four consecutive fix-sets to this code were each wrong in a way only a real process revealed. A
 * mocked `process.kill` would have passed every one of them.
 */

const jobs = jobTracker('spec-reap');

afterEach(() => {
  jobs.cleanup();
});

const newJob = jobs.newJob;

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

      expect(await registry.reapJob(jobId)).toEqual([entry.id]);
      expect(registry.listFor(jobId)).toHaveLength(0);
      // The point of the whole test: forgetting it is only safe because it is genuinely dead.
      await waitFor(() => !alive(entry.pid), 'the forgotten group to be dead');
    } finally {
      killGroup({ pgid: entry.pgid, signal: 'SIGKILL' });
    }
  });

  /**
   * The case the escalation was built for and did not cover: a service nobody ever pressed `k` on.
   *
   * `reapJob` is reached from a job deletion and from a claim taken over by another Atlas, and in
   * BOTH the service is healthy and `running` when the sweep arrives — nobody has stopped it by
   * hand. A one-shot SIGTERM plus `byJob.delete` was therefore the ordinary path, not the edge: a
   * deaf dev server survived, was reported as killed, and became unreachable to every later layer.
   * The escalation has to come from the sweep itself, not from a status a human happened to set.
   */
  it('reapJob insists on a running group that never answered its SIGTERM', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: DEAF });

    try {
      // No `stop()` first — this is a healthy service being reaped out from under itself.
      expect(entry.status).toBe(EServiceStatus.running);

      await registry.reapJob(jobId);
      expect(registry.listFor(jobId)).toHaveLength(0);
      await waitFor(() => !alive(entry.pid), 'the deaf group to be insisted on');
    } finally {
      killGroup({ pgid: entry.pgid, signal: 'SIGKILL' });
    }
  });

  /**
   * The orphan has to stay visible until it is confirmed dead, or the escalation is just a slower
   * leak: if Atlas goes away inside the grace window, layer 3 is the only thing left that can kill
   * the group, and it sweeps `allServices()`.
   */
  it('keeps a reaped-but-living group reachable to the exit backstop', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: DEAF });

    try {
      // NOT awaited: the whole assertion is about what is visible while the grace is still running.
      const reaped = registry.reapJob(jobId);

      // Gone from the job — the UI and the mirror have forgotten it — but not gone from the sweep.
      expect(registry.listFor(jobId)).toHaveLength(0);
      expect(registry.allServices()).toContain(entry);
      await reaped;

      await waitFor(() => !alive(entry.pid), 'the orphan to be killed');
      await waitFor(
        () => !registry.allServices().includes(entry),
        'the orphan to be dropped once it is dead',
      );
    } finally {
      killGroup({ pgid: entry.pgid, signal: 'SIGKILL' });
    }
  });

  /**
   * The hole the orphan list was supposed to close and did not: `reapAll` only ever walked `byJob`,
   * so the graceful quit path — which is what BOTH real quits go through — could not see an orphan
   * at all. A job deleted 50 ms before a quit therefore leaked its group, and the only thing that
   * had ever appeared to cover it was an unrelated job's service happening to hold the loop open.
   */
  it('sweeps an orphan that is still mid-grace, not just the jobs it still has', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: DEAF });

    // Held rather than voided: its grace and the `finally` that mutates `orphans` would otherwise
    // resolve inside whichever test runs next.
    let reaped: Promise<string[]> | undefined;
    try {
      // Deliberately not AWAITED here: this is the window between a job deletion and the escalation.
      reaped = registry.reapJob(jobId);
      expect(registry.listFor(jobId)).toHaveLength(0);

      expect(registry.reapAll({ signal: 'SIGKILL' })).toContain(entry);
      await waitFor(() => !alive(entry.pid), 'the orphan to die on the quit path');
    } finally {
      await reaped;
      killGroup({ pgid: entry.pgid, signal: 'SIGKILL' });
    }
  });

  /**
   * A service that dies POLITELY inside the grace must be seen to have died.
   *
   * The exit watcher used to bail on anything absent from `listFor`, which an orphan always is — so
   * `exitCode` was never written, `mayStillBeAlive` stayed true forever, and the escalation fired a
   * blind SIGKILL at a pgid that had been free for 300 ms. That is precisely the "signalling a
   * stranger" hazard `mayStillBeAlive`'s own docstring exists to prevent.
   */
  it('records the exit of an orphan that went quietly, and does not insist on it', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: 'sleep 30' });

    await registry.reapJob(jobId);

    expect(alive(entry.pid)).toBe(false);
    // The watched death, not an ESRCH: this one was seen to go, so it carries a code.
    expect(entry.exitCode).not.toBeUndefined();
    expect(mayStillBeAlive(entry)).toBe(false);
  });

  /**
   * `reapJob` has to be awaitable, and the reason is `deleteJob`: it calls `purgeJobFiles` on the
   * very next line, which `rmSync`s the job directory — the logs AND the `services.json` that is the
   * only record a crash-orphan reconcile could ever match against. A fire-and-forget escalation
   * meant the evidence was destroyed at t=0 while the group lived to t=300, which is the exact
   * failure the ordering comment in `workspace.service.ts` says the ordering exists to prevent.
   */
  it('resolves only once the group it could not ask politely is actually dead', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: DEAF });

    try {
      await registry.reapJob(jobId);
      // `waitFor`, not a bare assertion: a just-SIGKILLed child is a zombie for a beat and still
      // answers `kill(pid, 0)`. What is being pinned is that the WAIT happened, not the reaping.
      await waitFor(() => !alive(entry.pid), 'the insisted-on group to be gone');
    } finally {
      killGroup({ pgid: entry.pgid, signal: 'SIGKILL' });
    }
  });

  /**
   * Two reaps for one job, which `use-claim`'s fire-and-forget takeover makes real: it reaps on a
   * takeover, and a `deleteJob` landing inside that grace calls `reapJob` again.
   *
   * The second used to return `[]` in 0 ms — the first reap deletes the job from `byJob` before its
   * grace, so `byJob.get` misses and the caller cannot tell "already being reaped" from "no services
   * here". `deleteJob` then believed the group was dead and ran `purgeJobFiles`, destroying
   * `services.json` and the logs at t=0 while the group lived to t=300. Not a process leak — the
   * first reap still insists — but an EVIDENCE leak, and the invariant the await exists to hold.
   */
  it('makes a second reap of the same job wait for the first, not answer nothing', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: DEAF });

    try {
      const first = registry.reapJob(jobId);
      // The takeover's reap is in flight; this is `deleteJob` arriving behind it.
      await registry.reapJob(jobId);

      // The discriminator is the orphan list, not liveness: a just-SIGKILLed child is a zombie for a
      // beat. If the second call had answered `[]` without joining the first, the grace would still
      // be running and this entry would still be in `allServices()`.
      expect(registry.allServices()).not.toContain(entry);
      await waitFor(() => !alive(entry.pid), 'the group to be gone');
      await first;
    } finally {
      killGroup({ pgid: entry.pgid, signal: 'SIGKILL' });
    }
  });

  /**
   * The exit of a group we had to INSIST on must be recorded too.
   *
   * The splice out of `orphans` happens synchronously after `insist()`, before the SIGKILLed child's
   * `exited` resolves — so the watcher's tracking gate failed and `exitCode` was never written.
   * `mayStillBeAlive` then stayed true forever, and `reapGracefully`, which holds its own captured
   * list, re-signalled a pgid the kernel had already freed. That is the "signalling a stranger"
   * hazard, fixed for the polite orphan and left open for the insisted one.
   */
  it('records the exit of a group it had to insist on', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const entry = await startService({ registry, jobId, command: DEAF });

    try {
      await registry.reapJob(jobId);
      await waitFor(() => entry.exitCode !== undefined, 'the insisted-on exit to be recorded');
      expect(mayStillBeAlive(entry)).toBe(false);
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
