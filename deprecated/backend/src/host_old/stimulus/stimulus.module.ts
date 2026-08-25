import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobBootstrapModule } from '../job-bootstrap/job-bootstrap.module';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  InboundMessageEntity,
  JobEntity,
  RepoEntity,
  TranscriptMessageEntity,
} from '../persistence/entities';
import { ChatStimulusBridge } from './chat-stimulus.bridge';
import { DeliveryPump } from './delivery-pump.service';
import { EventFilterService } from './event-filter.service';
import { ProjectRoutingService } from './project-routing.service';
import { StimulusIntake } from './stimulus-intake.service';
import { StimulusStoreService } from './stimulus-store.service';
import { SurfaceOrchestration } from './surface-orchestration.service';

@Module({
  imports: [
    JobBootstrapModule,
    TypeOrmModule.forFeature(
      [RepoEntity, JobEntity, TranscriptMessageEntity, InboundMessageEntity],
      DB_CONNECTION,
    ),
  ],
  providers: [
    EventFilterService,
    StimulusStoreService,
    ProjectRoutingService,
    SurfaceOrchestration,
    StimulusIntake,
    ChatStimulusBridge,
    DeliveryPump,
  ],
  exports: [StimulusIntake, ProjectRoutingService, StimulusStoreService, DeliveryPump],
})
export class StimulusModule {}
