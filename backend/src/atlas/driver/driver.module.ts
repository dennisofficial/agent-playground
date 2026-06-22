import { EnvService } from '@core/config/env/env.service';
import { Global, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutoFixModule } from '../autofix';
import { JOB_DISPATCHER } from '../brain';
import { DecisionGateModule } from '../decision-gate';
import { CredentialResolver, OnboardingService } from '../onboarding';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  AtlasChannel,
  AtlasDecisionRecord,
  AtlasJob,
  AtlasPhase,
  AtlasProject,
  AtlasSection,
  AtlasThread,
  AtlasThreadSandbox,
} from '../persistence/entities';
import { RunnerModule } from '../runner';
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
        AtlasChannel,
        AtlasProject,
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
          (teamId) => creds.anthropicKey(teamId),
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
export class DriverModule implements OnApplicationBootstrap {
  constructor(
    private readonly driver: SectionDriver,
    private readonly env: EnvService,
  ) {}

  /** On boot, reconcile any in-flight jobs — re-enter the same straight drive at the persisted cursor. */
  async onApplicationBootstrap(): Promise<void> {
    // ATLAS_DISABLE_RESUME (dev/test): a fresh test instance skips the sweep so it doesn't re-attempt
    // prior runs' stale jobs.
    if (this.env.get('ATLAS_DISABLE_RESUME')) return;
    await this.driver.resume();
  }
}
