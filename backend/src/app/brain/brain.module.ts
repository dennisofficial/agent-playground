import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DecisionGateModule } from '../decision-gate';
import { GitModule } from '../git';
import { JobBootstrapModule } from '../job-bootstrap';
import { MemoryModule } from '../memory';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  MessageEntity,
  StageEntity,
  RepoEntity,
  ThreadEntity,
  StimulusEntity,
  JobEntity,
  JobSandboxEntity,
} from '../persistence/entities';
import { BRAIN_SINK, StimulusModule, type BrainSink } from '../stimulus';
import { AgentSessionManager } from './agent-session-manager.service';
import { DrainService } from './drain.service';
import { BrainStoreService } from './brain-store.service';
import { DecisionApprovalService } from './decision-approval.service';
import { JitHostExecutor } from './jit-host-executor';
import { PlanReviewService } from './plan-review.service';
import { SelfSufficiencyToolsService } from './self-sufficiency-tools.service';
import { TurnRecoveryService } from './turn-recovery.service';

/**
 * R3 — the ATLAS BRAIN module (rebuilt). Wires the brain that decides WHETHER/WHAT (never HOW):
 *
 *  - `AgentSessionManager` — the chat brain: per-thread Claude Agent SDK session running IN the
 *    thread's sandbox via the R1 tool bridge. It is the ONE brain per thread; chat continues its
 *    session and an event is delivered to it as a harness message (`deliverEvent`, server-initiated turn).
 *  - `DecisionApprovalService` — the human gate: posts the proposal card, awaits a verdict.
 *  - `BrainStoreService` — the brain's reads/writes on the 'app' connection.
 *
 * THE TWO SEAMS:
 *  - INPUT: `BRAIN_SINK` ⟵ a thin adapter over `AgentSessionManager` (chat → `handleChatTurn`,
 *    event → `deliverEvent`). The old `StimulusRouter` demux + the second event-only brain
 *    (`EventTriageService` / `BRAIN_LLM`) are deleted — there is only one brain per thread (ARCHITECTURE §7).
 *  - OUTPUT: `JOB_DISPATCHER` — bound by W4's @Global `DriverModule` (`useExisting: ThreadDriver`).
 *
 * Imports `DecisionGateModule` (classifier + park-and-ask), `MemoryModule` (recall), `DriverModule`
 * (JobLifecycleService + DriverStoreService for the brain tools). `CHAT_SURFACE` comes from the
 * @Global `SurfaceModule`. `DockerEngineRunner` comes from the @Global `SandboxModule`.
 * Composed into the app by `FeaturesModule`. Zero v1 imports.
 *
 * @Global so the `BRAIN_SINK` it binds is the one `StimulusIntake` resolves.
 */
@Global()
@Module({
  imports: [
    DecisionGateModule,
    GitModule,
    JobBootstrapModule,
    MemoryModule,
    StimulusModule,
    TypeOrmModule.forFeature(
      [
        JobEntity,
        MessageEntity,
        StageEntity,
        DecisionRecordEntity,
        ThreadEntity,
        StimulusEntity,
        RepoEntity,
        JobSandboxEntity,
      ],
      DB_CONNECTION,
    ),
  ],
  providers: [
    BrainStoreService,
    DecisionApprovalService,
    PlanReviewService,
    TurnRecoveryService,
    AgentSessionManager,
    DrainService,
    JitHostExecutor,
    SelfSufficiencyToolsService,
    // INPUT SEAM — the brain IS the sink (chat → its session, event → a harness-message delivery).
    {
      provide: BRAIN_SINK,
      inject: [AgentSessionManager],
      useFactory: (brain: AgentSessionManager): BrainSink => ({
        handleChat: (s) => brain.handleChatTurn(s),
        enqueueChat: (s) => brain.enqueueChat(s),
        deliverEvent: (s) => brain.deliverEvent(s),
      }),
    },
    // OUTPUT SEAM (`JOB_DISPATCHER`) is bound by W4's @Global DriverModule (useExisting: ThreadDriver).
    // DRIVER→BRAIN SEAM: the driver reaches the brain through the @Global neutral `BrainGateway`
    // (BrainGatewayModule); AgentSessionManager registers itself into it on bootstrap. Binding it here as
    // a `useExisting` port would close a DI construction cycle (the brain constructs the driver services).
  ],
  exports: [
    AgentSessionManager,
    DecisionApprovalService,
    BrainStoreService,
    JitHostExecutor,
    SelfSufficiencyToolsService,
    BRAIN_SINK,
  ],
})
export class BrainModule {}
