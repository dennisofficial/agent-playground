import { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnvService } from '@core/config/env/env.service';
import type { ExposureService } from '../../exposure/exposure.service';
import type { OnboardingService } from '../../onboarding/onboarding.service';
import type { ChatSurface } from '../../surface/chat-surface.port';
import type { LeaderElectionService } from '../../cluster/leader-election.service';
import { DriverModule } from '../driver.module';
import type { GitStateReconciler } from '../git-state-reconciler.service';
import type { JobLifecycleService } from '../job-lifecycle.service';
import type { JobUnblockSweep } from '../job-unblock-sweep.service';
import type { SessionResumeSweep } from '../session-resume-sweep.service';
import type { ThreadDriver } from '../thread-driver.service';

describe('DriverModule — promote wiring re-drives yielded jobs (leadership fence pairing)', () => {
  function harness(options: { exposure?: ExposureService } = {}) {
    const driver = {
      resume: vi.fn(async () => undefined),
    } as unknown as ThreadDriver;
    const lifecycle = {
      reconcileOnBoot: vi.fn(async () => undefined),
      reconcileDeletingJobs: vi.fn(async () => undefined),
      reconcileArchivedSandboxes: vi.fn(async () => undefined),
      reapIdle: vi.fn(async () => undefined),
      pollPrClosures: vi.fn(async () => undefined),
      archiveInactiveJobs: vi.fn(async () => undefined),
      reapOrphanedSandboxArtifacts: vi.fn(async () => undefined),
    } as unknown as JobLifecycleService;
    const reconciler = {
      tick: vi.fn(async () => 0),
    } as unknown as GitStateReconciler;
    const sessionResumeSweep = {
      tick: vi.fn(async () => undefined),
    } as unknown as SessionResumeSweep;
    const jobUnblockSweep = {
      tick: vi.fn(async () => 0),
    } as unknown as JobUnblockSweep;
    let promoteCb: (() => void | Promise<void>) | undefined;
    let demoteCb: (() => void | Promise<void>) | undefined;
    const election = {
      onPromote: vi.fn((cb: () => void | Promise<void>) => {
        promoteCb = cb;
        return { unsubscribe: vi.fn() };
      }),
      onDemote: vi.fn((cb: () => void | Promise<void>) => {
        demoteCb = cb;
        return { unsubscribe: vi.fn() };
      }),
    } as unknown as LeaderElectionService;
    const env = { get: vi.fn(() => undefined) } as unknown as EnvService;
    const surface = { resumeRequests$: undefined } as unknown as ChatSurface;
    const onboarding = {
      ensureWebhooksForActiveRepos: vi.fn(async () => undefined),
    } as unknown as OnboardingService;
    const scheduler = new SchedulerRegistry();
    const mod = new DriverModule(
      driver,
      env,
      lifecycle,
      reconciler,
      sessionResumeSweep,
      jobUnblockSweep,
      election,
      surface,
      onboarding,
      scheduler,
      options.exposure,
    );
    return {
      mod,
      driver,
      lifecycle,
      reconciler,
      onboarding,
      promote: () => promoteCb!(),
      demote: () => demoteCb!(),
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs reconcileOnBoot ONCE but re-drives running jobs on EVERY promotion (mid-life re-promote must not strand a yielded job)', async () => {
    const h = harness();
    await h.mod.onApplicationBootstrap();

    await h.promote(); // first promotion (boot)
    await h.promote(); // mid-life re-promote (lost + regained the lock on a blip)

    expect(h.lifecycle.reconcileOnBoot).toHaveBeenCalledTimes(1);
    expect(h.driver.resume).toHaveBeenCalledTimes(2);

    h.mod.onApplicationShutdown();
  });

  it('the leader reap tick re-drives running jobs (at-least-once backstop for the yield-vs-repromote race)', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.mod.onApplicationBootstrap();
    await h.promote(); // starts the reap timer; resume() called once here

    expect(h.driver.resume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000); // one reap interval (default)
    expect((h.driver.resume as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(
      2,
    );

    h.mod.onApplicationShutdown();
  });

  it('sweeps orphaned sandbox artifacts ONCE per process on boot BEFORE resuming jobs, and again on each reap tick', async () => {
    vi.useFakeTimers();
    const h = harness();
    const reapArtifacts = h.lifecycle.reapOrphanedSandboxArtifacts as ReturnType<typeof vi.fn>;
    const resume = h.driver.resume as ReturnType<typeof vi.fn>;
    await h.mod.onApplicationBootstrap();

    await h.promote(); // first promotion (boot)
    await h.promote(); // mid-life re-promote

    expect(reapArtifacts).toHaveBeenCalledTimes(1);
    expect(reapArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
      resume.mock.invocationCallOrder[0],
    );

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(reapArtifacts.mock.calls.length).toBeGreaterThanOrEqual(2);

    h.mod.onApplicationShutdown();
  });

  it('runs idle-reap on its own fast 1-min timer (not the slow sweep), and demotion stops it', async () => {
    vi.useFakeTimers();
    const h = harness();
    const reapIdle = h.lifecycle.reapIdle as ReturnType<typeof vi.fn>;
    await h.mod.onApplicationBootstrap();
    await h.promote(); // starts the fast idle-reap timer

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(reapIdle.mock.calls.length).toBeGreaterThanOrEqual(3);

    h.demote();
    const afterDemote = reapIdle.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(reapIdle.mock.calls.length).toBe(afterDemote);

    h.mod.onApplicationShutdown();
  });

  it('the fast heartbeat runs the reconciler tick on the leader, and demotion stops it', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.mod.onApplicationBootstrap();
    await h.promote(); // starts the fast poll timer

    await vi.advanceTimersByTimeAsync(15 * 1000); // one heartbeat
    const afterOne = (h.reconciler.tick as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(afterOne).toBeGreaterThanOrEqual(1);

    h.demote();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect((h.reconciler.tick as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterOne);

    h.mod.onApplicationShutdown();
  });

  it('starts the preview reconcile timer even when public preview URLs are disabled', async () => {
    vi.useFakeTimers();
    const exposure = {
      enabled: false,
      reconcileAll: vi.fn(async () => undefined),
    } as unknown as ExposureService;
    const h = harness({ exposure });
    await h.mod.onApplicationBootstrap();
    await h.promote();

    await vi.advanceTimersByTimeAsync(10 * 1000);
    expect(exposure.reconcileAll).toHaveBeenCalled();

    h.mod.onApplicationShutdown();
  });

  it('a slow tick does not overlap — the heartbeat skips while the prior tick is in flight', async () => {
    vi.useFakeTimers();
    const h = harness();
    let resolveTick: (() => void) | undefined;
    (h.reconciler.tick as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<number>((res) => (resolveTick = () => res(0))),
    );
    await h.mod.onApplicationBootstrap();
    await h.promote();

    await vi.advanceTimersByTimeAsync(15 * 1000); // first heartbeat starts a tick (still pending)
    await vi.advanceTimersByTimeAsync(15 * 1000); // second heartbeat — guarded, must NOT start another tick
    expect((h.reconciler.tick as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    resolveTick?.();
    h.mod.onApplicationShutdown();
  });
});
