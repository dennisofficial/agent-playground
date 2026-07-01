import { EnvService } from '@core/config/env/env.service';
import {
  Global,
  Inject,
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
import { CredentialResolver, OnboardingService } from '../onboarding';
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
} from '../persistence/entities';
import { RunnerModule } from '../runner';
// Direct port path (NOT the '../surface' barrel) to stay clear of a SurfaceModule ↔ DriverModule cycle.
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import { PLANNER_LLM, AnthropicPlannerLlm } from './planner-llm';
import { BuildShipService } from './build-ship.service';
import { DriverStoreService } from './driver-store.service';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import { DRIVER_REPO, GitDriverRepoResolver } from './repo-resolver';
import { ThreadDriver } from './thread-driver.service';
import { JobLifecycleService } from './job-lifecycle.service';
import { WorktreeHydrator } from './worktree-hydrator.service';
import { WorktreeProvisioner } from './worktree-provisioner.service';

/**
 * W4 — the SECTION/PHASE DRIVER module. Composes the deterministic, resumable `async` pipeline that
 * turns an approved `Job` into ONE PR:
 *   - `ThreadDriver` — the legible top-to-bottom driver (plan → review → gate → execute steps →
 *     auto-fix → handoff → one PR), bound as the REAL `JOB_DISPATCHER`.
 *   - `DriverStoreService` — the track/step row reads/writes (explicit, resumable `status`/`step`).
 *   - `GitDriverRepoResolver` (behind `DRIVER_REPO`) — a job's project → a ready-to-use repo.
 *   - `PLANNER_LLM` — the track planner's chat-model port (a declarative chain on a hardcoded Sonnet,
 *     keyed off `ANTHROPIC_API_KEY`; key-less → the driver falls back to a single-step plan).
 *
 * THE DISPATCH SEAM OVERRIDE: `BrainModule` no longer binds the `JOB_DISPATCHER` no-op (it kept
 * `LoggingJobDispatcher` only as an exported fallback) — exactly the precedent W3 set with the
 * `BRAIN_SINK` binding over W2's no-op. This @Global module provides + exports the REAL binding
 * (`useExisting: ThreadDriver`), so the brain's `@Inject(JOB_DISPATCHER)` resolves to the driver with
 * ZERO changes anywhere else.
 *
 * Consumes W5 (`DecisionGateModule`: classifier + park-and-ask + visibility), W7 (`AutoFixModule`), and
 * W1 (`RunnerModule`: turn-runner + engine + git). `CHAT_SURFACE` comes from the @Global `SurfaceModule`.
 * On boot it reconciles in-flight jobs (`ThreadDriver.resume`). Zero v1 imports.
 */
@Global()
@Module({
  imports: [
    RunnerModule,
    DecisionGateModule,
    AutoFixModule,
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
      ],
      DB_CONNECTION,
    ),
  ],
  providers: [
    DriverStoreService,
    PipelineAwarenessStore,
    BuildShipService,
    { provide: DRIVER_REPO, useClass: GitDriverRepoResolver },
    {
      provide: PLANNER_LLM,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver) =>
        new AnthropicPlannerLlm((orgId) => creds.anthropicKey(orgId)),
    },
    ThreadDriver,
    JobLifecycleService,
    WorktreeHydrator,
    WorktreeProvisioner,
    // THE DISPATCH SEAM — the real driver overrides W3's no-op (removed from BrainModule).
    { provide: JOB_DISPATCHER, useExisting: ThreadDriver },
  ],
  exports: [
    ThreadDriver,
    JOB_DISPATCHER,
    JobLifecycleService,
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
  private bootReconciled = false; // crash-recovery sweep runs ONCE per process, not on every re-promote

  constructor(
    private readonly driver: ThreadDriver,
    private readonly env: EnvService,
    private readonly lifecycle: JobLifecycleService,
    private readonly election: LeaderElectionService,
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
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
      // Crash-recovery sweep runs ONCE per process (the first time this instance wins leadership, by
      // the drain-then-release invariant any predecessor has already drained). A mid-life RE-promote
      // (lost+regained the lock on a connection blip) must NOT re-run it: reconcileOnBoot nulls
      // container_id and resume re-drives jobs — destructive while turns are still executing here.
      if (!this.bootReconciled) {
        this.bootReconciled = true;
        // Mark per-thread sandboxes detached (next turn re-attaches) BEFORE resuming jobs — resumed
        // drives call `ensureContainer`, which expects the reconciled state.
        await this.lifecycle.reconcileOnBoot();
        await this.driver.resume();
      }
      this.startReapTimer(); // transient: stopped on demote, restarted on every promote
    });
    this.demoteSub = this.election.onDemote(() => this.stopReapTimer());
  }

  /**
   * Periodically reap idle thread-sandbox containers (worktrees survive) AND close threads whose PR has
   * merged/closed (reclaims container + worktree). unref so it never keeps the process alive.
   */
  private startReapTimer(): void {
    if (this.reapTimer) return;
    const everyMs = Number(this.env.get('SANDBOX_REAP_INTERVAL_MS')) || 30 * 60 * 1000;
    this.reapTimer = setInterval(() => {
      void this.lifecycle.reapIdle().catch(() => undefined);
      void this.lifecycle.pollPrClosures().catch(() => undefined);
    }, everyMs);
    this.reapTimer.unref?.();
  }

  private stopReapTimer(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = undefined;
    }
  }

  onApplicationShutdown(): void {
    this.resumeSub?.unsubscribe();
    this.promoteSub?.unsubscribe();
    this.demoteSub?.unsubscribe();
    this.stopReapTimer();
  }
}
