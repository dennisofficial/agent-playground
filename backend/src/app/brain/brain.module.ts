import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DecisionGateModule } from '../decision-gate';
import { MemoryModule } from '../memory';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  MessageEntity,
  PlanReviewEntity,
  StepEntity,
  RepoEntity,
  TrackEntity,
  StimulusEntity,
  ThreadEntity,
  ThreadSandboxEntity,
} from '../persistence/entities';
import { DockerEngineRunner } from '../sandbox/docker-engine-runner';
import { STIMULUS_CONSUMER } from '../stimulus';
import { BRAIN_LLM, AnthropicBrainLlm } from './brain-llm';
import { AgentSessionManager } from './agent-session-manager.service';
import { DrainService } from './drain.service';
import { BrainStoreService } from './brain-store.service';
import { DecisionApprovalService } from './decision-approval.service';
import { EventTriageService } from './event-triage.service';
import { StimulusRouter } from './stimulus-router.service';
import { PlanReviewService } from './plan-review.service';

/**
 * R3 — the ATLAS BRAIN module (rebuilt). Wires the brain that decides WHETHER/WHAT (never HOW):
 *
 *  - `StimulusRouter` — bound as the `STIMULUS_CONSUMER`: routes chat → `AgentSessionManager`,
 *    event → `EventTriageService`.
 *  - `AgentSessionManager` — the new chat brain: per-thread Claude Agent SDK session running
 *    IN the thread's sandbox via the R1 tool bridge. 6 host-side tools: get_pipeline_state,
 *    get_decision_record, recall, remember, submit_plan, dispatch_build.
 *  - `EventTriageService` — the UNCHANGED event triage lane (verbatim extract from the old
 *    TriageService): untrusted-notification security gate + park-and-ask + autonomous bugfix dispatch.
 *  - `DecisionApprovalService` — the human gate: posts the proposal card, awaits a verdict.
 *  - `BrainStoreService` — the brain's reads/writes on the 'app' connection.
 *  - `BRAIN_LLM` — the triage chat-model port (events only; grill deleted in R3).
 *
 * DELETED in R3: `ConversationalBrainService`, `ScopingInvestigatorService`, the chat half of
 * `TriageService`, the grill half of `brain-llm.ts`. The in-sandbox AgentSessionManager replaces them.
 *
 * THE TWO SEAMS:
 *  - INPUT: `STIMULUS_CONSUMER` ⟵ `StimulusRouter` (replaces the old TriageService binding).
 *  - OUTPUT: `JOB_DISPATCHER` — bound by W4's @Global `DriverModule` (`useExisting: TrackDriver`).
 *
 * Imports `DecisionGateModule` (classifier + park-and-ask), `MemoryModule` (recall), `DriverModule`
 * (ThreadLifecycleService + DriverStoreService for the brain tools). `CHAT_SURFACE` comes from the
 * @Global `SurfaceModule`. `DockerEngineRunner` comes from the @Global `SandboxModule`.
 * Composed into the app by `FeaturesModule`. Zero v1 imports.
 *
 * @Global so the `STIMULUS_CONSUMER` it binds is the one `StimulusIntake` resolves.
 */
@Global()
@Module({
  imports: [
    DecisionGateModule,
    MemoryModule,
    TypeOrmModule.forFeature(
      [
        ThreadEntity,
        MessageEntity,
        PlanReviewEntity,
        DecisionRecordEntity,
        TrackEntity,
        StepEntity,
        StimulusEntity,
        RepoEntity,
        ThreadSandboxEntity,
      ],
      DB_CONNECTION,
    ),
  ],
  providers: [
    {
      provide: BRAIN_LLM,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver) =>
        new AnthropicBrainLlm((orgId) => creds.anthropicKey(orgId)),
    },
    BrainStoreService,
    DecisionApprovalService,
    EventTriageService,
    PlanReviewService,
    AgentSessionManager,
    DrainService,
    StimulusRouter,
    // INPUT SEAM — the router IS the stimulus consumer (replaces the old TriageService binding).
    { provide: STIMULUS_CONSUMER, useExisting: StimulusRouter },
    // OUTPUT SEAM (`JOB_DISPATCHER`) is bound by W4's @Global DriverModule (useExisting: TrackDriver).
  ],
  exports: [
    StimulusRouter,
    EventTriageService,
    AgentSessionManager,
    DecisionApprovalService,
    BrainStoreService,
    STIMULUS_CONSUMER,
    BRAIN_LLM,
  ],
})
export class BrainModule {}
