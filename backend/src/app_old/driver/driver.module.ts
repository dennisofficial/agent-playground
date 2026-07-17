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
import { AutoFixModule } from '../autofix/autofix.module';
import { JOB_DISPATCHER } from '../brain/job-dispatcher';
import { LeaderElectionService } from '../cluster/leader-election.service';
import { DecisionGateModule } from '../decision-gate/decision-gate.module';
import { DriverApprovalGateway } from '../driver-approval-gateway/driver-approval-gateway.service';
import { ExposureService } from '../exposure/exposure.service';
import { JobBootstrapModule } from '../job-bootstrap/job-bootstrap.module';
import { OnboardingService } from '../onboarding/onboarding.service';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  InboundMessageEntity,
  JobEntity,
  JobSandboxEntity,
  RepoEntity,
  TaskEntity,
  ThreadEntity,
  ThreadGroupEntity,
  TranscriptMessageEntity,
} from '../persistence/entities';
import { RunnerModule } from '../runner/runner.module';
import { TurnReattachRegistry } from '../sandbox/turn-reattach.registry';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import { StimulusModule } from '../stimulus/stimulus.module';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import { descriptorForLane } from '../surface/thread-registry';
import { AutoMergeService } from './auto-merge.service';
import { BaseMoveMergeabilitySync } from './base-move-mergeability-sync.service';
import { BuildLaneDeliveryService, LANE_SEEDER } from './build-lane-delivery.service';
import { BuildShipService } from './build-ship.service';
import { DriverStoreService } from './driver-store.service';
import { GitStateReconciler } from './git-state-reconciler.service';
import { GithubCiStateSync } from './github-ci-state-sync.service';
import { GithubPrStateSync } from './github-pr-state-sync.service';
import { GithubTokenRefreshService } from './github-token-refresh.service';
import { JobLifecycleService } from './job-lifecycle.service';
import { JOB_TEARDOWN } from './job-teardown.port';
import { JobUnblockSweep } from './job-unblock-sweep.service';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import { DRIVER_REPO, GitDriverRepoResolver } from './repo-resolver';
import { SessionResumeSweep } from './session-resume-sweep.service';
import { ThreadDriver } from './thread-driver.service';
import { WorktreeHydrator } from './worktree-hydrator.service';
import { WorktreeProvisioner } from './worktree-provisioner.service';

const REAP_INTERVAL = 'driver:reap';
const REAP_IDLE_INTERVAL = 'driver:reap-idle';
const POLL_INTERVAL = 'driver:poll';
const SESSION_RESUME_INTERVAL = 'driver:session-resume';
const JOB_UNBLOCK_INTERVAL = 'driver:job-unblock';
const PREVIEW_INTERVAL = 'driver:preview';
const TOKEN_REFRESH_INTERVAL = 'driver:token-refresh';
const BUILD_LANE_SWEEP_INTERVAL = 'driver:build-lane-sweep';

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
    { provide: JOB_DISPATCHER, useExisting: ThreadDriver },
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
    BaseMoveMergeabilitySync,
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
export class DriverModule implements OnApplicationBootstrap, OnApplicationShutdown {
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
    @Optional() private readonly exposure?: ExposureService,
    @Optional() private readonly tokenRefresh?: GithubTokenRefreshService,
    @Optional() private readonly reattachRegistry?: TurnReattachRegistry,
    @Optional() private readonly buildLaneDelivery?: BuildLaneDeliveryService,
    @Optional() private readonly stimulusStore?: StimulusStoreService,
    @Optional() private readonly driverApproval?: DriverApprovalGateway,
    @Optional() private readonly driverStore?: DriverStoreService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.driverApproval && this.driverStore) {
      const driver = this.driver;
      const store = this.driverStore;
      this.driverApproval.bind({
        resolveShip: async (jobId, ruledBy) => {
          await driver.resolveShipApprovalDurably(jobId, ruledBy);
        },
        retractShip: (jobId, ruledBy) => driver.retractShipDurably(jobId, ruledBy),
        resolveMerge: (jobId, ruledBy) => driver.resolveMergeApprovalDurably(jobId, ruledBy),
        neutralizeAmendProposal: (jobId, verdictLine) =>
          store.neutralizeAmendProposal(jobId, verdictLine),
      });
    }

    this.reattachRegistry?.register('step', (row) => this.driver.reattachTurnRow(row));

    this.resumeSub = this.surface.resumeRequests$?.subscribe(({ jobId }) => {
      void this.driver.resumePaused(jobId);
    });

    if (this.env.get('DISABLE_RESUME')) return;

    this.promoteSub = this.election.onPromote(async () => {
      if (!this.bootReconciled) {
        this.bootReconciled = true;
        await this.lifecycle.reconcileOnBoot();
        await this.lifecycle.reconcileDeletingJobs().catch(() => undefined);
        await this.lifecycle.reconcileArchivedSandboxes().catch(() => undefined);
        await this.lifecycle
          .reapOrphanedSandboxArtifacts()
          .catch((err) => this.logger.warn(`boot orphan-artifact sweep failed: ${err}`));
      }
      if (!this.webhooksBackfilled) {
        this.webhooksBackfilled = true;
        void this.onboarding
          .ensureWebhooksForActiveRepos()
          .catch((err) => this.logger.warn(`webhook backfill sweep failed: ${err}`));
      }
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

  private startReapTimer(): void {
    if (this.scheduler.doesExist('interval', REAP_INTERVAL)) return;
    const everyMs = 30 * 60 * 1000; // 30m — PR-merge cleanup + housekeeping sweep cadence.
    const iv = setInterval(() => {
      void this.driver.resume().catch(() => undefined);
      void this.lifecycle.pollPrClosures().catch(() => undefined);
      void this.lifecycle.reconcileDeletingJobs().catch(() => undefined);
      void this.lifecycle.archiveInactiveJobs().catch(() => undefined);
      void this.lifecycle.reconcileArchivedSandboxes().catch(() => undefined);
      void this.lifecycle.reapOrphanedSandboxArtifacts().catch(() => undefined);
    }, everyMs);
    iv.unref?.(); // never keep the process alive (SchedulerRegistry does not unref for us)
    this.scheduler.addInterval(REAP_INTERVAL, iv);
  }

  private stopReapTimer(): void {
    if (this.scheduler.doesExist('interval', REAP_INTERVAL)) {
      this.scheduler.deleteInterval(REAP_INTERVAL);
    }
  }

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

  private startTokenRefreshTimer(): void {
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
        this.logger.debug(`build-lane sweep pump failed for thread=${threadId}: ${err}`),
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
