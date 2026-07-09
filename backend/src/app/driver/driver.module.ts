import { EnvService } from '@core/config/env/env.service';
import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Subscription } from 'rxjs';
import { AutoFixModule } from '../autofix';
import { JOB_DISPATCHER } from '../brain';
import { LeaderElectionService } from '../cluster';
import { DecisionGateModule } from '../decision-gate';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  MessageEntity,
  StepEntity,
  RepoEntity,
  ThreadEntity,
  StimulusEntity,
  JobEntity,
  JobSandboxEntity,
  CodexReviewEntity,
} from '../persistence/entities';
import { RunnerModule } from '../runner';
import { StimulusModule } from '../stimulus';
// Direct port path (NOT the '../surface' barrel) to stay clear of a SurfaceModule ↔ DriverModule cycle.
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import { GitStateReconciler } from './git-state-reconciler.service';
import { BuildShipService } from './build-ship.service';
import { DriverStoreService } from './driver-store.service';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import { DRIVER_REPO, GitDriverRepoResolver } from './repo-resolver';
import { ThreadDriver } from './thread-driver.service';
import { JobLifecycleService } from './job-lifecycle.service';
import { GithubPrStateSync } from './github-pr-state-sync.service';
import { OnboardingService } from '../onboarding';
import { WorktreeHydrator } from './worktree-hydrator.service';
import { WorktreeProvisioner } from './worktree-provisioner.service';

/**
 * W4 — the SECTION/PHASE DRIVER module. Composes the deterministic, resumable `async` pipeline that
 * turns an approved `Job` into ONE PR:
 *   - `ThreadDriver` — the legible top-to-bottom driver (lock-step → visibility → execute → auto-fix →
 *     handoff → one PR), bound as the REAL `JOB_DISPATCHER`.
 *   - `DriverStoreService` — the thread/step row reads/writes (explicit, resumable `status`/`step`).
 *   - `GitDriverRepoResolver` (behind `DRIVER_REPO`) — a job's project → a ready-to-use repo.
 *
 * THE DISPATCH SEAM OVERRIDE: `BrainModule` no longer binds the `JOB_DISPATCHER` no-op (it kept
 * `LoggingJobDispatcher` only as an exported fallback) — exactly the precedent W3 set with the
 * `BRAIN_SINK` binding over W2's no-op. This @Global module provides + exports the REAL binding
 * (`useExisting: ThreadDriver`), so the brain's `@Inject(JOB_DISPATCHER)` resolves to the driver with
 * ZERO changes anywhere else.
 *
 * Consumes W5 (`DecisionGateModule`: classifier + visibility), W7 (`AutoFixModule`), and
 * W1 (`RunnerModule`: turn-runner + engine + git). `CHAT_SURFACE` comes from the @Global `SurfaceModule`.
 * On boot it reconciles in-flight jobs (`ThreadDriver.resume`). Zero v1 imports.
 */
@Global()
@Module({
  imports: [
    RunnerModule,
    DecisionGateModule,
    AutoFixModule,
    StimulusModule, // the reconciler routes GitHub state-changes back to the owning brain via StimulusIntake
    TypeOrmModule.forFeature(
      [
        ThreadEntity,
        StepEntity,
        DecisionRecordEntity,
        JobEntity,
        RepoEntity,
        JobSandboxEntity,
        MessageEntity,
        StimulusEntity,
        CodexReviewEntity,
      ],
      DB_CONNECTION,
    ),
  ],
  providers: [
    DriverStoreService,
    PipelineAwarenessStore,
    BuildShipService,
    { provide: DRIVER_REPO, useClass: GitDriverRepoResolver },
    ThreadDriver,
    JobLifecycleService,
    GithubPrStateSync,
    GitStateReconciler,
    WorktreeHydrator,
    WorktreeProvisioner,
    // THE DISPATCH SEAM — the real driver overrides W3's no-op (removed from BrainModule).
    { provide: JOB_DISPATCHER, useExisting: ThreadDriver },
  ],
  exports: [
    ThreadDriver,
    JOB_DISPATCHER,
    JobLifecycleService,
    GithubPrStateSync,
    // Exported so the @Global surface + the ingress state-webhook controller can reach `markRepoDue`
    // (a base-branch push marks the repo's open PRs due-now for the fast heartbeat).
    GitStateReconciler,
    WorktreeProvisioner,
    DriverStoreService,
    PipelineAwarenessStore,
    BuildShipService,
    DRIVER_REPO,
  ],
})
export class DriverModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private resumeSub?: Subscription;
  private promoteSub?: Subscription;
  private demoteSub?: Subscription;
  private reapTimer?: ReturnType<typeof setInterval>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private pollInFlight = false; // skip a heartbeat if the prior tick is still running (slow GitHub / many PRs)
  private readonly logger = new Logger(DriverModule.name);
  private bootReconciled = false; // crash-recovery sweep runs ONCE per process, not on every re-promote
  private webhooksBackfilled = false; // per-repo webhook backfill runs ONCE per process on leadership

  constructor(
    private readonly driver: ThreadDriver,
    private readonly env: EnvService,
    private readonly lifecycle: JobLifecycleService,
    private readonly reconciler: GitStateReconciler,
    private readonly election: LeaderElectionService,
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    private readonly onboarding: OnboardingService,
  ) {}

  /**
   * The boot reconcile + job resume + the idle reaper are LEADER-ONLY singleton duties — they tear down
   * / re-drive sandboxes, which must never run in two processes at once. Gate them behind leadership: a
   * follower stays quiet; on promotion (which, by the drain-then-release invariant, only happens once any
   * predecessor has fully drained) it reconciles, resumes, and starts the reaper.
   */
  async onApplicationBootstrap(): Promise<void> {
    // Operator resume requests (POST /web/resume) → re-drive the paused job. Subscribed unconditionally,
    // independent of leadership (the agent test surface omits resumeRequests$; Caddy routes /resume only
    // to the leader anyway).
    this.resumeSub = this.surface.resumeRequests$?.subscribe(({ jobId }) => {
      void this.driver.resumePaused(jobId);
    });

    // DISABLE_RESUME (dev/test): a fresh test instance skips the sweep so it doesn't re-attempt
    // prior runs' stale jobs (and skips the sandbox reaper/reconcile).
    if (this.env.get('DISABLE_RESUME')) return;

    this.promoteSub = this.election.onPromote(async () => {
      // reconcileOnBoot nulls container_id, so it runs ONCE per process (the first time this instance wins
      // leadership; by the drain-then-release invariant any predecessor has already drained). A mid-life
      // RE-promote (lost+regained the lock on a connection blip) must NOT re-run that reconcile.
      if (!this.bootReconciled) {
        this.bootReconciled = true;
        // Mark per-thread sandboxes detached (next turn re-attaches) BEFORE resuming jobs — resumed
        // drives call `ensureContainer`, which expects the reconciled state.
        await this.lifecycle.reconcileOnBoot();
        // Finish any job stranded in `deleting` (crash between the delete claim and teardown completing).
        await this.lifecycle.reconcileDeletingJobs().catch(() => undefined);
      }
      // Best-effort: register the GitHub delivery webhooks for already-connected repos so the fast path is
      // live without a re-connect. Once per process, fire-and-forget — never blocks resume, and skips
      // itself when the backend isn't publicly reachable. The 30-min poll covers sync regardless.
      if (!this.webhooksBackfilled) {
        this.webhooksBackfilled = true;
        void this.onboarding
          .ensureWebhooksForActiveRepos()
          .catch((err) => this.logger.warn(`webhook backfill sweep failed: ${err}`));
      }
      // Re-drive `running` jobs on EVERY promotion — including a mid-life re-promote. Leadership-fenced
      // drives (see ThreadDriver.runJob) YIELD on demotion, so a re-promote must re-pick-up the yielded job or
      // it strands `running` with no driver. Safe + idempotent: resume()→drive() and drive()'s in-process
      // `active` guard skips any job whose drive is still in flight (a fast demote→repromote blip that beat
      // the drive's yield checkpoint); yielded jobs are re-driven and runJob fast-forwards completed work.
      await this.driver.resume();
      this.startReapTimer(); // transient: stopped on demote, restarted on every promote
      this.startPollTimer(); // the fast adaptive PR-state heartbeat (leader-only, like the reap timer)
    });
    this.demoteSub = this.election.onDemote(() => {
      this.stopReapTimer();
      this.stopPollTimer();
    });
  }

  /**
   * Periodically reap idle thread-sandbox containers (worktrees survive) AND close threads whose PR has
   * merged/closed (reclaims container + worktree). unref so it never keeps the process alive. The GitHub
   * PR-state observation itself now rides the fast `startPollTimer` heartbeat, NOT this slow sweep — this
   * timer keeps only idle-reap + the `pollPrClosures` merge/close-teardown backstop (teardown is already
   * real-time via the `/webhooks/github/state` webhook) + the stranded-job re-drive backstop.
   */
  private startReapTimer(): void {
    if (this.reapTimer) return;
    const everyMs = 30 * 60 * 1000; // 30m — idle-reap + PR-merge cleanup sweep cadence.
    this.reapTimer = setInterval(() => {
      // At-least-once re-drive backstop: leadership-fenced drives yield on demotion, and the promote-time
      // resume() covers the normal re-promote — but a demote landing DURING a drive's yield (before drive()
      // clears its `active` guard) can race the re-promote resume() and strand the job `running`. This
      // idempotent sweep re-drives any such stranded job within one interval (skips in-flight via `active`).
      void this.driver.resume().catch(() => undefined);
      void this.lifecycle.reapIdle().catch(() => undefined);
      void this.lifecycle.pollPrClosures().catch(() => undefined);
      void this.lifecycle.reconcileDeletingJobs().catch(() => undefined);
    }, everyMs);
    this.reapTimer.unref?.();
  }

  private stopReapTimer(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = undefined;
    }
  }

  /**
   * The FAST adaptive PR-state heartbeat (~15s) — the leader observes GitHub for every DUE open PR:
   * refreshes the CI/mergeable UI columns + routes merge conflicts back to the owning brain (the flagship
   * signal webhooks don't emit), then re-stamps each job's durable `next_poll_at` clock by adaptive
   * cadence so a hot PR (GitHub still computing mergeability) is re-checked in ~8s while a settled one
   * relaxes to ~45s. Replaces the old fixed 30-min git-state sweep. Leader-only (like the reap timer):
   * it tears/re-drives nothing, but must not double-poll from two processes. `unref` so it never keeps
   * the process alive; `pollInFlight` guards against overlap when a tick runs long.
   */
  private startPollTimer(): void {
    if (this.pollTimer) return;
    const everyMs = 15 * 1000; // 15s — the fast heartbeat; the reconciler's per-PR cadence does the throttling.
    this.pollTimer = setInterval(() => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      void this.reconciler
        .tick()
        .catch((err) => this.logger.warn(`git-state tick failed: ${err}`))
        .finally(() => {
          this.pollInFlight = false;
        });
    }, everyMs);
    this.pollTimer.unref?.();
  }

  private stopPollTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  onApplicationShutdown(): void {
    this.resumeSub?.unsubscribe();
    this.promoteSub?.unsubscribe();
    this.demoteSub?.unsubscribe();
    this.stopReapTimer();
    this.stopPollTimer();
  }
}
