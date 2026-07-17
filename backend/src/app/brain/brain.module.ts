import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DecisionGateModule } from '../decision-gate/decision-gate.module';
import { GitModule } from '../git/git.module';
import { JobBootstrapModule } from '../job-bootstrap/job-bootstrap.module';
import { MemoryModule } from '../memory/memory.module';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  InboundMessageEntity,
  JobEntity,
  JobSandboxEntity,
  OrganizationEntity,
  RepoEntity,
  ThreadEntity,
  ThreadGroupEntity,
  TranscriptMessageEntity,
} from '../persistence/entities';
import { BRAIN_SINK, BrainSink } from '../stimulus/stimulus-consumer';
import { StimulusModule } from '../stimulus/stimulus.module';
import { AgentSessionManager } from './agent-session-manager.service';
import { BrainStoreService } from './brain-store.service';
import { DecisionApprovalService } from './decision-approval.service';
import { DrainService } from './drain.service';
import { JitHostExecutor } from './jit-host-executor';
import { PlanReviewService } from './plan-review.service';
import { SelfSufficiencyToolsService } from './self-sufficiency-tools.service';
import { TurnRecoveryService } from './turn-recovery.service';

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
        TranscriptMessageEntity,
        ThreadGroupEntity,
        DecisionRecordEntity,
        ThreadEntity,
        InboundMessageEntity,
        RepoEntity,
        JobSandboxEntity,
        OrganizationEntity,
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
    {
      provide: BRAIN_SINK,
      inject: [AgentSessionManager],
      useFactory: (brain: AgentSessionManager): BrainSink => ({
        handleChat: (s) => brain.handleChatTurn(s),
        enqueueChat: (s) => brain.enqueueChat(s),
        deliverEvent: (s) => brain.deliverEvent(s),
      }),
    },
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
