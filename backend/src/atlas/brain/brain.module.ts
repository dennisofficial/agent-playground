import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DecisionGateModule } from '../decision-gate';
import { EngineModule } from '../engine';
import { GitModule } from '../git';
import { MemoryModule } from '../memory';
import { CredentialResolver } from '../onboarding';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  AtlasChannel,
  AtlasDecisionRecord,
  AtlasJob,
  AtlasMessage,
  AtlasProject,
  AtlasSection,
  AtlasStimulus,
  AtlasThread,
} from '../persistence/entities';
import { STIMULUS_CONSUMER } from '../stimulus';
import { ATLAS_BRAIN_LLM, AnthropicBrainLlm } from './brain-llm';
import { BrainStoreService } from './brain-store.service';
import { ConversationalBrainService } from './conversational-brain.service';
import { DecisionApprovalService } from './decision-approval.service';
import { ScopingInvestigatorService } from './scoping-investigator.service';
import { TriageService } from './triage.service';

/**
 * W3 — the ATLAS BRAIN module. Wires the brain that decides WHETHER/WHAT (never HOW):
 *
 *  - `TriageService` — bound as the `STIMULUS_CONSUMER` (replacing W2's logging no-op): one cheap
 *    triage turn per surviving stimulus → ignore / ask / dispatch. Chat drives the grill; an untrusted
 *    event is triaged as DATA behind the always-ask security gate.
 *  - `ConversationalBrainService` — the grill: reads the thread transcript + recalled memory, asks
 *    clarifying questions until it can lock a decision record + a high-level section list.
 *  - `DecisionApprovalService` — the human gate: posts the proposal card, awaits a verdict.
 *  - `BrainStoreService` — the brain's reads/writes on the 'atlas' connection (transcript + the
 *    decision record / job / section rows).
 *  - `ATLAS_BRAIN_LLM` — the fakeable chat-model port (Sonnet off `ANTHROPIC_API_KEY` / `CHAT_MODEL`,
 *    no new env var; key-less → the brain falls back to a safe default).
 *
 * THE TWO SEAMS:
 *  - INPUT: `STIMULUS_CONSUMER` ⟵ `TriageService` (mirrors W2's pattern; overrides the no-op consumer).
 *  - OUTPUT: `JOB_DISPATCHER` — bound by W4's @Global `DriverModule` (`useExisting: SectionDriver`). This
 *    module no longer binds it (it kept `LoggingJobDispatcher` only as an exported fallback class) —
 *    exactly the precedent W3 set when it removed W2's local `STIMULUS_CONSUMER` no-op. The brain's
 *    `@Inject(JOB_DISPATCHER)` resolves to the driver from the global module, zero changes here.
 *
 * Imports `DecisionGateModule` (classifier + park-and-ask) and `MemoryModule` (recall). `CHAT_SURFACE`
 * comes from the @Global `SurfaceModule`. Composed into the app by `AppModule`. Zero v1 imports.
 *
 * @Global so the `STIMULUS_CONSUMER` it binds is the one `StimulusIntake` (in `StimulusModule`) resolves:
 * W2 deliberately stopped binding a local default once a real consumer exists, so the brain owns the
 * single binding — the override the W2 seam was designed for, without a circular import.
 */
@Global()
@Module({
  imports: [
    DecisionGateModule,
    MemoryModule,
    EngineModule,
    GitModule,
    TypeOrmModule.forFeature(
      [
        AtlasThread,
        AtlasMessage,
        AtlasChannel,
        AtlasJob,
        AtlasDecisionRecord,
        AtlasSection,
        AtlasStimulus,
        AtlasProject,
      ],
      ATLAS_CONNECTION,
    ),
  ],
  providers: [
    {
      provide: ATLAS_BRAIN_LLM,
      inject: [EnvService, CredentialResolver],
      useFactory: (env: EnvService, creds: CredentialResolver) =>
        new AnthropicBrainLlm(
          (teamId) => creds.anthropicKey(teamId),
          () => env.get('CHAT_MODEL'),
        ),
    },
    BrainStoreService,
    ScopingInvestigatorService,
    ConversationalBrainService,
    DecisionApprovalService,
    TriageService,
    // INPUT SEAM — the brain IS the stimulus consumer (replaces W2's logging no-op).
    { provide: STIMULUS_CONSUMER, useExisting: TriageService },
    // OUTPUT SEAM (`JOB_DISPATCHER`) is bound by W4's @Global DriverModule (useExisting: SectionDriver).
  ],
  exports: [
    TriageService,
    ConversationalBrainService,
    DecisionApprovalService,
    BrainStoreService,
    ScopingInvestigatorService,
    STIMULUS_CONSUMER,
    ATLAS_BRAIN_LLM,
  ],
})
export class BrainModule {}
