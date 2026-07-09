import { afterEach, describe, expect, it, vi } from 'vitest';

import { DriverModule } from './driver.module';
import type { ThreadDriver } from './thread-driver.service';
import type { JobLifecycleService } from './job-lifecycle.service';
import type { GitStateReconciler } from './git-state-reconciler.service';
import type { LeaderElectionService } from '../cluster';
import type { EnvService } from '@core/config/env/env.service';
import type { ChatSurface } from '../surface';
import type { OnboardingService } from '../onboarding';

/**
 * The promote/demote wiring is the load-bearing pair for the leadership-fenced drive: because a fenced drive
 * YIELDS on demotion (leaving the job `running`), a re-promote MUST re-drive it or it strands. These tests
 * lock that contract at the module seam.
 */
describe('DriverModule — promote wiring re-drives yielded jobs (leadership fence pairing)', () => {
  function harness() {
    const driver = {
      resume: vi.fn(async () => undefined),
    } as unknown as ThreadDriver;
    const lifecycle = {
      reconcileOnBoot: vi.fn(async () => undefined),
      reconcileDeletingJobs: vi.fn(async () => undefined),
      reapIdle: vi.fn(async () => undefined),
      pollPrClosures: vi.fn(async () => undefined),
    } as unknown as JobLifecycleService;
    const reconciler = {
      reconcile: vi.fn(async () => undefined),
    } as unknown as GitStateReconciler;
    let promoteCb: (() => void | Promise<void>) | undefined;
    const election = {
      onPromote: vi.fn((cb: () => void | Promise<void>) => {
        promoteCb = cb;
        return { unsubscribe: vi.fn() };
      }),
      onDemote: vi.fn(() => ({ unsubscribe: vi.fn() })),
    } as unknown as LeaderElectionService;
    const env = { get: vi.fn(() => undefined) } as unknown as EnvService;
    const surface = { resumeRequests$: undefined } as unknown as ChatSurface;
    const onboarding = {
      ensureWebhooksForActiveRepos: vi.fn(async () => undefined),
    } as unknown as OnboardingService;
    const mod = new DriverModule(driver, env, lifecycle, reconciler, election, surface, onboarding);
    return { mod, driver, lifecycle, reconciler, onboarding, promote: () => promoteCb!() };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs reconcileOnBoot ONCE but re-drives running jobs on EVERY promotion (mid-life re-promote must not strand a yielded job)', async () => {
    const h = harness();
    await h.mod.onApplicationBootstrap();

    await h.promote(); // first promotion (boot)
    await h.promote(); // mid-life re-promote (lost + regained the lock on a blip)

    // The destructive boot reconcile (nulls container_id) is once-per-process…
    expect(h.lifecycle.reconcileOnBoot).toHaveBeenCalledTimes(1);
    // …but resume() (idempotent re-drive of running jobs) fires on BOTH promotions.
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
    // The tick's idempotent resume() ran, re-driving any stranded running job.
    expect((h.driver.resume as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);

    h.mod.onApplicationShutdown();
  });
});
