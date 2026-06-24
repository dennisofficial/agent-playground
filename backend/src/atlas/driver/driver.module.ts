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
import { DecisionGateModule } from '../decision-gate';
import { CredentialResolver, OnboardingService } from '../onboarding';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  AtlasDecisionRecord,
  AtlasJob,
  AtlasPhase,
  AtlasRepo,
  AtlasSection,
  AtlasThread,
  AtlasThreadSandbox,
} from '../persistence/entities';
import { RunnerModule } from '../runner';
// Direct port path (NOT the '../surface' barrel) to stay clear of a SurfaceModule ↔ DriverModule cycle.
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import { ATLAS_PLANNER_LLM, AnthropicPlannerLlm } from './planner-llm';
import { DriverStoreService } from './driver-store.service';
import { ATLAS_DRIVER_REPO, GitDriverRepoResolver } from './repo-resolver';
import { SectionDriver } from './section-driver.service';
import { ThreadLifecycleService } from './thread-lifecycle.service';

/**
 * W4 — the SECTION/PHASE DRIVER module. Composes the deterministic, resumable `async` pipeline that
 * turns an approved `Job` into ONE PR:
 *   - `SectionDriver` — the legible top-to-bottom driver (plan → review → gate → execute phases →
 *     auto-fix → handoff → one PR), bound as the REAL `JOB_DISPATCHER`.
 *   - `DriverStoreService` — the section/phase row reads/writes (explicit, resumable `status`/`step`).
 *   - `GitDriverRepoResolver` (behind `ATLAS_DRIVER_REPO`) — a job's project → a ready-to-use repo.
 *   - `ATLAS_PLANNER_LLM` — the section planner's chat-model port (Sonnet off `ANTHROPIC_API_KEY` /
 *     `CHAT_MODEL`, no new env var; key-less → the driver falls back to a single-phase plan).
 *
 * THE DISPATCH SEAM OVERRIDE: `BrainModule` no longer binds the `JOB_DISPATCHER` no-op (it kept
 * `LoggingJobDispatcher` only as an exported fallback) — exactly the precedent W3 set when it removed
 * W2's local `STIMULUS_CONSUMER` no-op. This @Global module provides + exports the REAL binding
 * (`useExisting: SectionDriver`), so the brain's `@Inject(JOB_DISPATCHER)` resolves to the driver with
 * ZERO changes anywhere else.
 *
 * Consumes W5 (`DecisionGateModule`: classifier + park-and-ask + visibility), W7 (`AutoFixModule`), and
 * W1 (`RunnerModule`: turn-runner + engine + git). `CHAT_SURFACE` comes from the @Global `SurfaceModule`.
 * On boot it reconciles in-flight jobs (`SectionDriver.resume`). Zero v1 imports.
 */
@Global()
@Module({
  imports: [
    RunnerModule,
    DecisionGateModule,
    AutoFixModule,
    TypeOrmModule.forFeature(
      [
        AtlasJob,
        AtlasSection,
        AtlasPhase,
        AtlasDecisionRecord,
        AtlasThread,
        AtlasRepo,
        AtlasThreadSandbox,
      ],
      ATLAS_CONNECTION,
    ),
  ],
  providers: [
    DriverStoreService,
    { provide: ATLAS_DRIVER_REPO, useClass: GitDriverRepoResolver },
    {
      provide: ATLAS_PLANNER_LLM,
      inject: [EnvService, CredentialResolver],
      useFactory: (env: EnvService, creds: CredentialResolver) =>
        new AnthropicPlannerLlm(
          (orgId) => creds.anthropicKey(orgId),
          () => env.get('CHAT_MODEL'),
        ),
    },
    SectionDriver,
    ThreadLifecycleService,
    // THE DISPATCH SEAM — the real driver overrides W3's no-op (removed from BrainModule).
    { provide: JOB_DISPATCHER, useExisting: SectionDriver },
  ],
  exports: [SectionDriver, JOB_DISPATCHER, ThreadLifecycleService, DriverStoreService],
})
export class DriverModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private resumeSub?: Subscription;
  private reapTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly driver: SectionDriver,
    private readonly env: EnvService,
    private readonly lifecycle: ThreadLifecycleService,
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
  ) {}

  /** On boot, reconcile any in-flight jobs — re-enter the same straight drive at the persisted cursor. */
  async onApplicationBootstrap(): Promise<void> {
    // Operator resume requests (POST /web/resume) → re-drive the paused job. Subscribed unconditionally,
    // independent of the boot reconcile sweep below (the agent test surface omits resumeRequests$).
    this.resumeSub = this.surface.resumeRequests$?.subscribe(({ jobId }) => {
      void this.driver.resumePaused(jobId);
    });

    // ATLAS_DISABLE_RESUME (dev/test): a fresh test instance skips the sweep so it doesn't re-attempt
    // prior runs' stale jobs (and skips the sandbox reaper/reconcile).
    if (this.env.get('ATLAS_DISABLE_RESUME')) return;

    // Reconcile per-thread sandboxes (mark detached; next turn re-attaches) BEFORE resuming jobs —
    // resumed drives call `ensureContainer`, which expects the reconciled state.
    await this.lifecycle.reconcileOnBoot();
    await this.driver.resume();

    // Periodically reap idle thread-sandbox containers (worktrees survive) AND close threads whose PR
    // has merged/closed (reclaims container + worktree). unref so it never keeps the process alive.
    const everyMs = Number(this.env.get('ATLAS_SANDBOX_REAP_INTERVAL_MS')) || 30 * 60 * 1000;
    this.reapTimer = setInterval(() => {
      void this.lifecycle.reapIdle().catch(() => undefined);
      void this.lifecycle.pollPrClosures().catch(() => undefined);
    }, everyMs);
    this.reapTimer.unref?.();
  }

  onApplicationShutdown(): void {
    this.resumeSub?.unsubscribe();
    if (this.reapTimer) clearInterval(this.reapTimer);
  }
}
