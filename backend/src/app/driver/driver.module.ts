import { EnvService } from '@core/config/env/env.service';
import {
  Global,
  Inject,
  Logger,
  Module,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
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
import { SessionResumeSweep } from './session-resume-sweep.service';
import { JobUnblockSweep } from './job-unblock-sweep.service';
import { BuildShipService } from './build-ship.service';
import { DriverStoreService } from './driver-store.service';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import { DRIVER_REPO, GitDriverRepoResolver } from './repo-resolver';
import { ThreadDriver } from './thread-driver.service';
import { JobLifecycleService } from './job-lifecycle.service';
import { JOB_TEARDOWN } from './job-teardown.port';
import { GithubPrStateSync } from './github-pr-state-sync.service';
import { GithubCiStateSync } from './github-ci-state-sync.service';
import { OnboardingService } from '../onboarding';
import { WorktreeHydrator } from './worktree-hydrator.service';
import { WorktreeProvisioner } from './worktree-provisioner.service';
import { ExposureService } from '../exposure';

// SchedulerRegistry interval names (process-unique) for the leader-gated driver timers. Registered on
// promote, deleted on demote — the leader-only lifecycle is unchanged; only the timer plumbing moved off
// hand-rolled setInterval onto @nestjs/schedule.
const REAP_INTERVAL = 'driver:reap';
const REAP_IDLE_INTERVAL = 'driver:reap-idle';
const POLL_INTERVAL = 'driver:poll';
const SESSION_RESUME_INTERVAL = 'driver:session-resume';
const JOB_UNBLOCK_INTERVAL = 'driver:job-unblock';
const PREVIEW_INTERVAL = 'driver:preview';

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
    GithubCiStateSync,
    GitStateReconciler,
    SessionResumeSweep,
    JobUnblockSweep,
    WorktreeHydrator,
    WorktreeProvisioner,
    // THE DISPATCH SEAM — the real driver overrides W3's no-op (removed from BrainModule).
    { provide: JOB_DISPATCHER, useExisting: ThreadDriver },
    // The physical job-teardown seam — lets callers outside the driver (OrganizationService.deleteOrg)
    // reclaim a job's container + worktree WITHOUT a static import of the driver (which would close an
    // ES module cycle). @Global export, so no `imports: [DriverModule]` edge is needed either.
    { provide: JOB_TEARDOWN, useExisting: JobLifecycleService },
  ],
  exports: [
    ThreadDriver,
    JOB_DISPATCHER,
    JobLifecycleService,
    JOB_TEARDOWN,
    GithubPrStateSync,
    GithubCiStateSync,
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
  private pollInFlight = false; // skip a heartbeat if the prior tick is still running (slow GitHub / many PRs)
  private sessionResumeInFlight = false; // skip a tick if the prior session-resume sweep is still running
  private jobUnblockInFlight = false; // skip a tick if the prior job-unblock sweep is still running
  private previewInFlight = false; // skip a preview reconcile if the prior tick is still converging Caddy
  private readonly logger = new Logger(DriverModule.name);
  private bootReconciled = false; // crash-recovery sweep runs ONCE per process, not on every re-promote
  private webhooksBackfilled = false; // per-repo webhook backfill runs ONCE per process on leadership

  constructor(
    private readonly driver: ThreadDriver,
    private readonly env: EnvService,
    private readonly lifecycle: JobLifecycleService,
    private readonly reconciler: GitStateReconciler,
    private readonly sessionResumeSweep: SessionResumeSweep,
    private readonly jobUnblockSweep: JobUnblockSweep,
    private readonly election: LeaderElectionService,
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    private readonly onboarding: OnboardingService,
    private readonly scheduler: SchedulerRegistry,
    // Sandbox-preview reconciler — swept on a short leader-only timer so marker writes become Caddy routes
    // without relying on an open console tab. From the @Global ExposureModule; inert when disabled. @Optional
    // so the module's direct-construction unit test compiles without a trailing argument.
    @Optional() private readonly exposure?: ExposureService,
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
        // Reclaim leaked `-net`/`-dind` artifacts BEFORE resuming jobs — a resumed drive calls `ensureContainer`
        // → `ensureNetwork`, which fails ("all predefined address pools have been fully subnetted") if the pool
        // is still exhausted by networks orphaned across prior restarts. `reconcileOnBoot` above nulled DB
        // `container_id`s, but the sweep checks LIVE docker container names, so a still-running sandbox's network
        // is protected. Awaited (bounded, cheap); never blocks promotion on failure.
        await this.lifecycle
          .reapOrphanedSandboxArtifacts()
          .catch((err) => this.logger.warn(`boot orphan-artifact sweep failed: ${err}`));
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
      this.startReapIdleTimer(); // fast idle-reap sweep (1 min), leader-only
      this.startPollTimer(); // the fast adaptive PR-state heartbeat (leader-only, like the reap timer)
      this.startSessionResumeTimer(); // auto-resume lanes parked on a Claude session limit (leader-only)
      this.startJobUnblockTimer(); // backstop: wake blocked jobs whose blockers are all terminal (leader-only)
      this.startPreviewTimer(); // the marker → Caddy-route reconciler (leader-only, exposure-gated)
    });
    this.demoteSub = this.election.onDemote(() => {
      this.stopReapTimer();
      this.stopReapIdleTimer();
      this.stopPollTimer();
      this.stopSessionResumeTimer();
      this.stopJobUnblockTimer();
      this.stopPreviewTimer();
    });
  }

  /**
   * The slow housekeeping sweep: close threads whose PR has merged/closed (reclaims container + worktree),
   * re-drive stranded jobs, GC merged-job disk, and reclaim orphaned Docker artifacts. unref so it never
   * keeps the process alive. Idle-reap is NOT here — it rides its own fast `startReapIdleTimer` (1 min) so a
   * quiet container is reclaimed promptly; the GitHub PR-state observation rides the fast `startPollTimer`
   * heartbeat. This timer keeps only the `pollPrClosures` merge/close-teardown backstop (teardown is already
   * real-time via the `/webhooks/github/state` webhook) + the stranded-job re-drive backstop + the
   * orphaned-artifact sweep (leaked `-net`/`-dind` reclaim, so the Docker address pool can't exhaust).
   * `pollPrClosures` hits the GitHub API, so it stays on the slow cadence — do NOT move it to the fast timer.
   */
  private startReapTimer(): void {
    if (this.scheduler.doesExist('interval', REAP_INTERVAL)) return;
    const everyMs = 30 * 60 * 1000; // 30m — PR-merge cleanup + housekeeping sweep cadence.
    const iv = setInterval(() => {
      // At-least-once re-drive backstop: leadership-fenced drives yield on demotion, and the promote-time
      // resume() covers the normal re-promote — but a demote landing DURING a drive's yield (before drive()
      // clears its `active` guard) can race the re-promote resume() and strand the job `running`. This
      // idempotent sweep re-drives any such stranded job within one interval (skips in-flight via `active`).
      void this.driver.resume().catch(() => undefined);
      void this.lifecycle.pollPrClosures().catch(() => undefined);
      void this.lifecycle.reconcileDeletingJobs().catch(() => undefined);
      // Disk GC: reclaim the worktree + scratch dirs of merged/closed jobs whose sandbox has sat detached
      // past the TTL (RAM was freed at merge; this bounds the worktree growth detach leaves behind).
      void this.lifecycle.reapMergedSandboxes().catch(() => undefined);
      // Reclaim leaked per-sandbox `-net`/`-dind` artifacts so Docker's address pool can't be exhausted by
      // networks orphaned across restarts/crashes.
      void this.lifecycle.reapOrphanedSandboxArtifacts().catch(() => undefined);
    }, everyMs);
    iv.unref?.(); // never keep the process alive (SchedulerRegistry does not unref for us)
    this.scheduler.addInterval(REAP_INTERVAL, iv);
  }

  private stopReapTimer(): void {
    // deleteInterval clears the interval AND removes it from the registry.
    if (this.scheduler.doesExist('interval', REAP_INTERVAL)) {
      this.scheduler.deleteInterval(REAP_INTERVAL);
    }
  }

  /**
   * Fast idle-reap sweep (1 min): detach any attached-but-quiet container past the idle TTL (~30 min) to
   * free its RAM (the box bottleneck) — worktree + branch + session survive, so the next turn cold-reattaches.
   * `reapIdle` is cheap (a scoped DB read + per-row busy/activity guards) and skips mid-turn containers, so
   * running it every minute just tightens detection latency from up to ~30 min down to ~1 min. Leader-only
   * (like the other driver timers); unref so it never keeps the process alive.
   */
  private startReapIdleTimer(): void {
    if (this.scheduler.doesExist('interval', REAP_IDLE_INTERVAL)) return;
    const everyMs = 60 * 1000; // 1m — how often we check for containers past the idle TTL.
    const iv = setInterval(() => {
      void this.lifecycle.reapIdle().catch(() => undefined);
    }, everyMs);
    iv.unref?.(); // never keep the process alive (SchedulerRegistry does not unref for us)
    this.scheduler.addInterval(REAP_IDLE_INTERVAL, iv);
  }

  private stopReapIdleTimer(): void {
    if (this.scheduler.doesExist('interval', REAP_IDLE_INTERVAL)) {
      this.scheduler.deleteInterval(REAP_IDLE_INTERVAL);
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
    if (this.scheduler.doesExist('interval', POLL_INTERVAL)) return;
    const everyMs = 15 * 1000; // 15s — the fast heartbeat; the reconciler's per-PR cadence does the throttling.
    const iv = setInterval(() => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      void this.reconciler
        .tick()
        .catch((err) => this.logger.warn(`git-state tick failed: ${err}`))
        .finally(() => {
          this.pollInFlight = false;
        });
    }, everyMs);
    iv.unref?.();
    this.scheduler.addInterval(POLL_INTERVAL, iv);
  }

  private stopPollTimer(): void {
    if (this.scheduler.doesExist('interval', POLL_INTERVAL)) {
      this.scheduler.deleteInterval(POLL_INTERVAL);
    }
  }

  /**
   * The auto-resume heartbeat (~30s) — the leader un-parks every lane whose durable `session_resume_at` clock
   * is due (a Claude session/usage limit that has now reset). Leader-only (like the reap/poll timers): it
   * re-drives builds + wakes brains, which must never run in two processes. `unref` so it never keeps the
   * process alive; `sessionResumeInFlight` guards against overlap when a tick runs long.
   */
  private startSessionResumeTimer(): void {
    if (this.scheduler.doesExist('interval', SESSION_RESUME_INTERVAL)) return;
    const everyMs = 30 * 1000; // 30s — the resume-clock granularity; a few seconds past reset is fine.
    const iv = setInterval(() => {
      if (this.sessionResumeInFlight) return;
      this.sessionResumeInFlight = true;
      void this.sessionResumeSweep
        .tick()
        .catch((err) => this.logger.warn(`session-resume tick failed: ${err}`))
        .finally(() => {
          this.sessionResumeInFlight = false;
        });
    }, everyMs);
    iv.unref?.();
    this.scheduler.addInterval(SESSION_RESUME_INTERVAL, iv);
  }

  private stopSessionResumeTimer(): void {
    if (this.scheduler.doesExist('interval', SESSION_RESUME_INTERVAL)) {
      this.scheduler.deleteInterval(SESSION_RESUME_INTERVAL);
    }
  }

  /**
   * The job-unblock backstop heartbeat (~30s) — the leader re-reconciles every `blocked` job, waking any
   * whose blockers are all terminal-or-absent. The event-driven funnel ({@link JobDependencyService.onBlockerResolved})
   * handles the normal case; this catches a wake dropped by a crash. Leader-only (it wakes brains, which must
   * never run in two processes); `unref` so it never keeps the process alive; `jobUnblockInFlight` guards
   * against overlap when a tick runs long.
   */
  private startJobUnblockTimer(): void {
    if (this.scheduler.doesExist('interval', JOB_UNBLOCK_INTERVAL)) return;
    const everyMs = 30 * 1000; // 30s — a dropped wake is recovered within one tick.
    const iv = setInterval(() => {
      if (this.jobUnblockInFlight) return;
      this.jobUnblockInFlight = true;
      void this.jobUnblockSweep
        .tick()
        .catch((err) => this.logger.warn(`job-unblock tick failed: ${err}`))
        .finally(() => {
          this.jobUnblockInFlight = false;
        });
    }, everyMs);
    iv.unref?.();
    this.scheduler.addInterval(JOB_UNBLOCK_INTERVAL, iv);
  }

  private stopJobUnblockTimer(): void {
    if (this.scheduler.doesExist('interval', JOB_UNBLOCK_INTERVAL)) {
      this.scheduler.deleteInterval(JOB_UNBLOCK_INTERVAL);
    }
  }

  /**
   * The sandbox-preview reconcile heartbeat (~10s) — the leader turns supervised-service markers into live
   * Caddy routes (and prunes stale ones) without relying on an open console tab. Leader-only (it mutates
   * shared Caddy state) and inert unless the ExposureService is enabled (PREVIEW_BASE_DOMAIN set); `unref`
   * so it never keeps the process alive; `previewInFlight` guards against overlap when a tick runs long.
   */
  private startPreviewTimer(): void {
    if (!this.exposure?.enabled) return; // exposure disabled (no PREVIEW_BASE_DOMAIN) — nothing to reconcile
    if (this.scheduler.doesExist('interval', PREVIEW_INTERVAL)) return;
    const everyMs = 10 * 1000; // 10s — a marker write becomes a public route within a tick.
    const iv = setInterval(() => {
      if (this.previewInFlight) return;
      this.previewInFlight = true;
      void this.exposure
        ?.reconcileAll()
        .catch((err) => this.logger.warn(`preview reconcile failed: ${err}`))
        .finally(() => {
          this.previewInFlight = false;
        });
    }, everyMs);
    iv.unref?.();
    this.scheduler.addInterval(PREVIEW_INTERVAL, iv);
  }

  private stopPreviewTimer(): void {
    if (this.scheduler.doesExist('interval', PREVIEW_INTERVAL)) {
      this.scheduler.deleteInterval(PREVIEW_INTERVAL);
    }
  }

  onApplicationShutdown(): void {
    this.resumeSub?.unsubscribe();
    this.promoteSub?.unsubscribe();
    this.demoteSub?.unsubscribe();
    this.stopReapTimer();
    this.stopReapIdleTimer();
    this.stopPollTimer();
    this.stopSessionResumeTimer();
    this.stopJobUnblockTimer();
    this.stopPreviewTimer();
  }
}
