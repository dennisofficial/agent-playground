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
import { JobBootstrapModule } from '../job-bootstrap';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  TranscriptMessageEntity,
  ThreadGroupEntity,
  TaskEntity,
  RepoEntity,
  ThreadEntity,
  InboundMessageEntity,
  JobEntity,
  JobSandboxEntity,
} from '../persistence/entities';
import { RunnerModule } from '../runner';
import { TurnReattachRegistry } from '../sandbox/turn-reattach.registry';
import { StimulusModule, StimulusStoreService } from '../stimulus';
// Direct port path (NOT the '../surface' barrel) to stay clear of a SurfaceModule ↔ DriverModule cycle.
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import { descriptorForLane } from '../surface/thread-registry';
import { AutoMergeService } from './auto-merge.service';
import { GitStateReconciler } from './git-state-reconciler.service';
import { SessionResumeSweep } from './session-resume-sweep.service';
import { JobUnblockSweep } from './job-unblock-sweep.service';
import { BuildShipService } from './build-ship.service';
import { DriverStoreService } from './driver-store.service';
import {
  BuildLaneDeliveryService,
  LANE_SEEDER,
} from './build-lane-delivery.service';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import { DRIVER_REPO, GitDriverRepoResolver } from './repo-resolver';
import { ThreadDriver } from './thread-driver.service';
import { JobLifecycleService } from './job-lifecycle.service';
import { JOB_TEARDOWN } from './job-teardown.port';
import { GithubPrStateSync } from './github-pr-state-sync.service';
import { GithubCiStateSync } from './github-ci-state-sync.service';
import { GithubTokenRefreshService } from './github-token-refresh.service';
import { BaseMoveMergeabilitySync } from './base-move-mergeability-sync.service';
import { OnboardingService } from '../onboarding';
import { WorktreeHydrator } from './worktree-hydrator.service';
import { WorktreeProvisioner } from './worktree-provisioner.service';
import { ExposureService } from '../exposure';
import { DriverApprovalGateway } from '../driver-approval-gateway';

// SchedulerRegistry interval names (process-unique) for the leader-gated driver timers. Registered on
// promote, deleted on demote — the leader-only lifecycle is unchanged; only the timer plumbing moved off
// hand-rolled setInterval onto @nestjs/schedule.
const REAP_INTERVAL = 'driver:reap';
const REAP_IDLE_INTERVAL = 'driver:reap-idle';
const POLL_INTERVAL = 'driver:poll';
const SESSION_RESUME_INTERVAL = 'driver:session-resume';
const JOB_UNBLOCK_INTERVAL = 'driver:job-unblock';
const PREVIEW_INTERVAL = 'driver:preview';
const TOKEN_REFRESH_INTERVAL = 'driver:token-refresh';
const BUILD_LANE_SWEEP_INTERVAL = 'driver:build-lane-sweep';

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
    JobBootstrapModule,
    StimulusModule, // the reconciler routes GitHub state-changes back to the owning brain via StimulusIntake
    TypeOrmModule.forFeature(
      [
        ThreadEntity,
        ThreadGroupEntity,
        TaskEntity,
        DecisionRecordEntity,
        JobEntity,
        RepoEntity,
        JobSandboxEntity,
        TranscriptMessageEntity,
        InboundMessageEntity,
      ],
      DB_CONNECTION,
    ),
  ],
  providers: [
    DriverStoreService,
    PipelineAwarenessStore,
    BuildShipService,
    BuildLaneDeliveryService,
    // The lane-capable host-seed seam — lets the brain's `JitHostExecutor` route a build-lane target through
    // `seedLane` without a SurfaceModule↔DriverModule cycle (bound as a token so the injection stays @Optional).
    { provide: LANE_SEEDER, useExisting: BuildLaneDeliveryService },
    { provide: DRIVER_REPO, useClass: GitDriverRepoResolver },
    ThreadDriver,
    JobLifecycleService,
    AutoMergeService,
    GithubPrStateSync,
    GithubCiStateSync,
    GithubTokenRefreshService,
    BaseMoveMergeabilitySync,
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
    AutoMergeService,
    JOB_TEARDOWN,
    GithubPrStateSync,
    GithubCiStateSync,
    // Exported so the ingress state-webhook controller can reach `schedule` (batches a base-branch push
    // into the debounced GraphQL mergeability refresh instead of the per-PR REST fan-out).
    BaseMoveMergeabilitySync,
    // Exported so the @Global surface + the ingress state-webhook controller can reach `markRepoDue`/
    // `markJobDue` (per-PR re-arms for mergeability-affecting webhooks).
    GitStateReconciler,
    WorktreeProvisioner,
    DriverStoreService,
    PipelineAwarenessStore,
    BuildShipService,
    BuildLaneDeliveryService,
    LANE_SEEDER,
    DRIVER_REPO,
  ],
})
export class DriverModule
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private resumeSub?: Subscription;
  private promoteSub?: Subscription;
  private demoteSub?: Subscription;
  private pollInFlight = false; // skip a heartbeat if the prior tick is still running (slow GitHub / many PRs)
  private sessionResumeInFlight = false; // skip a tick if the prior session-resume sweep is still running
  private jobUnblockInFlight = false; // skip a tick if the prior job-unblock sweep is still running
  private previewInFlight = false; // skip a preview reconcile if the prior tick is still converging Caddy
  private tokenRefreshInFlight = false; // skip a token-refresh tick if the prior sweep is still running
  private buildLaneSweepInFlight = false; // skip a tick if the prior build-lane sweep is still running
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
    // App-mode in-sandbox git token-file refresh sweep — kept trailing + @Optional (like `exposure` above)
    // so the module's direct-construction unit test compiles without passing every new dependency.
    @Optional() private readonly tokenRefresh?: GithubTokenRefreshService,
    // The kind→owner reattach routing table (from @Global SandboxModule). The driver claims the build kinds
    // so the leader watchdog can re-drive an orphaned-but-alive build turn. @Optional so the module's
    // direct-construction unit test compiles without a trailing argument.
    @Optional() private readonly reattachRegistry?: TurnReattachRegistry,
    // The build-lane at-least-once sweep backstop — re-drives a lane's pending host seed(s) the way
    // {@link BuildLaneDeliveryService.seedLane}'s inline pump would, on a periodic cadence so a `now` seed
    // whose live-turn steer was dropped isn't stuck until the next Leg drain. @Optional so the module's
    // direct-construction unit test compiles without a trailing argument.
    @Optional() private readonly buildLaneDelivery?: BuildLaneDeliveryService,
    @Optional() private readonly stimulusStore?: StimulusStoreService,
    // The neutral surface→driver approval seam (from @Global DriverApprovalGatewayModule). The driver binds
    // its ship/merge/amend resolution methods into it on bootstrap so the web surface reaches them as a
    // typed injected collaborator instead of via a ModuleRef service-locator. @Optional + trailing so the
    // module's direct-construction unit test compiles without passing every new dependency.
    @Optional() private readonly driverApproval?: DriverApprovalGateway,
    // `DriverStoreService.neutralizeAmendProposal` is the one gateway method not owned by ThreadDriver, so
    // the store is injected here to back the bound adapter. @Optional + trailing for the same reason.
    @Optional() private readonly driverStore?: DriverStoreService,
  ) {}

  /**
   * The boot reconcile + job resume + the idle reaper are LEADER-ONLY singleton duties — they tear down
   * / re-drive sandboxes, which must never run in two processes at once. Gate them behind leadership: a
   * follower stays quiet; on promotion (which, by the drain-then-release invariant, only happens once any
   * predecessor has fully drained) it reconciles, resumes, and starts the reaper.
   */
  async onApplicationBootstrap(): Promise<void> {
    // Register the concrete driver adapter behind the neutral surface→driver approval gateway, so the web
    // surface's ship/merge/amend approval-click bridge forwards here — without the surface importing the
    // driver (which would close a module cycle, DriverModule already depends on the surface for CHAT_SURFACE).
    // Mirrors how AgentSessionManager binds itself into BrainGateway, and how reattachRegistry.register below
    // registers a driver-backed callback into a neutral @Global registry. Unconditional + leadership-agnostic
    // (approval clicks are leader-routed by Caddy anyway); the driveAfter/merge idempotence is unchanged.
    if (this.driverApproval && this.driverStore) {
      const driver = this.driver;
      const store = this.driverStore;
      this.driverApproval.bind({
        resolveShip: async (jobId, ruledBy) => {
          await driver.resolveShipApprovalDurably(jobId, ruledBy);
        },
        retractShip: (jobId, ruledBy) =>
          driver.retractShipDurably(jobId, ruledBy),
        resolveMerge: (jobId, ruledBy) =>
          driver.resolveMergeApprovalDurably(jobId, ruledBy),
        neutralizeAmendProposal: (jobId, verdictLine) =>
          store.neutralizeAmendProposal(jobId, verdictLine),
      });
    }

    // Claim the build kind the drive loop provably re-attaches (`runJob`→`findReattachableTurn` re-tails a
    // live `step` turn at its anchor) on the reattach routing table, so the leader watchdog can re-drive
    // an orphaned-but-alive build turn (see ThreadDriver.reattachTurnRow). `review`/`autofix` are intentionally
    // NOT claimed — the drive loop doesn't re-tail those at an anchor, so a re-drive could start a fresh stage
    // beside the still-live engine; they keep the once-per-boot `resume()` recovery + the watchdog safety-net.
    // Unconditional + idempotent — the watchdog itself is leader-only, so registration need not be gated.
    this.reattachRegistry?.register('step', (row) =>
      this.driver.reattachTurnRow(row),
    );

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
        // Self-heal any archived job whose filesystem reclaim was interrupted (status flipped, but the
        // worktree/container teardown never finished) — the archive analog of the `deleting` reconcile.
        await this.lifecycle.reconcileArchivedSandboxes().catch(() => undefined);
        // Reclaim leaked `-net`/`-dind` artifacts BEFORE resuming jobs — a resumed drive calls `ensureContainer`
        // → `ensureNetwork`, which fails ("all predefined address pools have been fully subnetted") if the pool
        // is still exhausted by networks orphaned across prior restarts. `reconcileOnBoot` above nulled DB
        // `container_id`s, but the sweep checks LIVE docker container names, so a still-running sandbox's network
        // is protected. Awaited (bounded, cheap); never blocks promotion on failure.
        await this.lifecycle
          .reapOrphanedSandboxArtifacts()
          .catch((err) =>
            this.logger.warn(`boot orphan-artifact sweep failed: ${err}`),
          );
      }
      // Best-effort: register the GitHub delivery webhooks for already-connected repos so the fast path is
      // live without a re-connect. Once per process, fire-and-forget — never blocks resume, and skips
      // itself when the backend isn't publicly reachable. The 30-min poll covers sync regardless.
      if (!this.webhooksBackfilled) {
        this.webhooksBackfilled = true;
        void this.onboarding
          .ensureWebhooksForActiveRepos()
          .catch((err) =>
            this.logger.warn(`webhook backfill sweep failed: ${err}`),
          );
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
      this.startPreviewTimer(); // the marker → port_state/Caddy reconciler (leader-only; Caddy is exposure-gated)
      this.startTokenRefreshTimer(); // app-mode in-sandbox git token-file refresh sweep (leader-only)
      this.startBuildLaneSweepTimer(); // build-lane host-seed at-least-once re-drive backstop (leader-only)
    });
    this.demoteSub = this.election.onDemote(() => {
      this.stopReapTimer();
      this.stopReapIdleTimer();
      this.stopPollTimer();
      this.stopSessionResumeTimer();
      this.stopJobUnblockTimer();
      this.stopPreviewTimer();
      this.stopTokenRefreshTimer();
      this.stopBuildLaneSweepTimer();
    });
  }

  /**
   * The slow housekeeping sweep: record terminal PR states, re-drive stranded jobs, auto-archive idle
   * merged/closed jobs (+ self-heal interrupted reclaims), and reclaim orphaned Docker artifacts. unref so it never
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
      // Auto-archive: reclaim the worktree + container + /playground of merged/closed jobs idle past the TTL
      // (last transcript activity, default 3d) — the row + transcript + /context survive. Replaces the old
      // 7-day merged-sandbox disk GC and drains the detached-worktree backlog over its first sweeps.
      void this.lifecycle.archiveInactiveJobs().catch(() => undefined);
      // Self-heal an interrupted archive reclaim: re-run the (idempotent) physical teardown for any archived
      // job whose sandbox never reached `closed` (a crash between the status flip and the reclaim finishing).
      void this.lifecycle.reconcileArchivedSandboxes().catch(() => undefined);
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
   * The sandbox-preview reconcile heartbeat (~10s) — the leader turns supervised-service markers into the
   * sidebar port_state column and, when PREVIEW_BASE_DOMAIN is set, live Caddy routes. Leader-only (the
   * column is WAL-replicated and Caddy state is shared); `unref` so it never keeps the process alive;
   * `previewInFlight` guards against overlap when a tick runs long.
   */
  private startPreviewTimer(): void {
    if (!this.exposure) return;
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

  /**
   * The app-mode in-sandbox GitHub token-file refresh sweep (~2 min) — rewrites every ACTIVE app-mode
   * sandbox's `/.atlas/github-token` file with the current cached installation token, so a build turn
   * spanning the token's ~hourly expiry keeps pushing/fetching authenticated (see
   * `GithubTokenRefreshService`). Leader-only (it writes host state shared across processes); `unref` so it
   * never keeps the process alive; `tokenRefreshInFlight` guards against overlap when a tick runs long.
   *
   * Cadence MUST stay strictly under the token service's 5-min pre-expiry refresh window
   * (`GitHubAppTokenService.getInstallationToken` returns the cached token until it has <5 min left): the
   * governing margin is that 5-min window, NOT the ~55-min token lifetime. A ≥5-min sweep could write a
   * still-cached token 6 min before expiry, then next land 5+ min AFTER it expired — leaving the in-sandbox
   * credential.helper `cat`ing an expired token mid-turn. At 2 min, at least one sweep always lands inside
   * the 5-min window and writes a freshly-minted token before the old one expires.
   */
  private startTokenRefreshTimer(): void {
    // Absent only in the module's direct-construction unit test (see the `@Optional` constructor note) —
    // the real app always registers `GithubTokenRefreshService` as a provider.
    if (!this.tokenRefresh) return;
    if (this.scheduler.doesExist('interval', TOKEN_REFRESH_INTERVAL)) return;
    const everyMs = 2 * 60 * 1000; // 2m — strictly under the token service's 5-min pre-expiry refresh window.
    const iv = setInterval(() => {
      if (this.tokenRefreshInFlight) return;
      this.tokenRefreshInFlight = true;
      void this.tokenRefresh!.tick()
        .catch((err) => this.logger.warn(`token-refresh tick failed: ${err}`))
        .finally(() => {
          this.tokenRefreshInFlight = false;
        });
    }, everyMs);
    iv.unref?.();
    this.scheduler.addInterval(TOKEN_REFRESH_INTERVAL, iv);
  }

  private stopTokenRefreshTimer(): void {
    if (this.scheduler.doesExist('interval', TOKEN_REFRESH_INTERVAL)) {
      this.scheduler.deleteInterval(TOKEN_REFRESH_INTERVAL);
    }
  }

  /**
   * The build-lane at-least-once sweep (~30s, matching the brain's `CHAT_SWEEP_INTERVAL`) — re-drives every
   * build lane (`thread:<threadId>`) still carrying an undelivered host seed. Mirrors the brain's
   * `sweepUndeliveredChat`: `undeliveredChatLanes()` is the worklist, `BuildLaneDeliveryService.pump` is the
   * re-drive (a live steerable Leg's `now` seed steers; otherwise it's a no-op — the row already waits for the
   * next Leg's `foldLegTaskWithSeeds` drain). This only tightens that backstop's latency; thread-END leftovers
   * are covered independently by `AgentSessionManager.escalateBuildLaneLeftovers` re-keying onto `main`.
   * Leader-only (mutates shared turn state); `unref` so it never keeps the process alive; `buildLaneSweepInFlight`
   * guards against overlap when a tick runs long. Absent `buildLaneDelivery`/`stimulusStore` (the module's
   * direct-construction unit test) → no-op.
   */
  private startBuildLaneSweepTimer(): void {
    if (!this.buildLaneDelivery || !this.stimulusStore) return;
    if (this.scheduler.doesExist('interval', BUILD_LANE_SWEEP_INTERVAL)) return;
    const everyMs = 30 * 1000; // 30s — matches the brain's CHAT_SWEEP_INTERVAL cadence.
    const iv = setInterval(() => {
      if (this.buildLaneSweepInFlight) return;
      this.buildLaneSweepInFlight = true;
      void this.buildLaneSweepTick().finally(() => {
        this.buildLaneSweepInFlight = false;
      });
    }, everyMs);
    iv.unref?.();
    this.scheduler.addInterval(BUILD_LANE_SWEEP_INTERVAL, iv);
  }

  private stopBuildLaneSweepTimer(): void {
    if (this.scheduler.doesExist('interval', BUILD_LANE_SWEEP_INTERVAL)) {
      this.scheduler.deleteInterval(BUILD_LANE_SWEEP_INTERVAL);
    }
  }

  private async buildLaneSweepTick(): Promise<void> {
    let lanes: Array<{
      jobId: string;
      orgId: string;
      repoId: string;
      lane: string;
    }>;
    try {
      lanes = await this.stimulusStore!.undeliveredChatLanes();
    } catch (err) {
      this.logger.debug(`build-lane sweep query failed (will retry): ${err}`);
      return;
    }
    for (const l of lanes) {
      const owner = descriptorForLane(l.lane);
      if (owner?.descriptor.kind !== 'builder') continue; // only build lanes; `main` rides the brain's own sweep
      const threadId = owner.ids[0];
      if (!threadId) continue;
      await this.buildLaneDelivery!.pump({
        jobId: l.jobId,
        orgId: l.orgId,
        repoId: l.repoId,
        threadId,
      }).catch((err) =>
        this.logger.debug(
          `build-lane sweep pump failed for thread=${threadId}: ${err}`,
        ),
      );
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
    this.stopTokenRefreshTimer();
    this.stopBuildLaneSweepTimer();
  }
}
