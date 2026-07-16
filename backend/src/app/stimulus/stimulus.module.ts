import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobBootstrapModule } from '../job-bootstrap';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  TranscriptMessageEntity,
  RepoEntity,
  InboundMessageEntity,
  JobEntity,
} from '../persistence/entities';
import { ChatStimulusBridge } from './chat-stimulus.bridge';
import { DeliveryPump } from './delivery-pump.service';
import { EventFilterService } from './event-filter.service';
import { ProjectRoutingService } from './project-routing.service';
import { StimulusIntake } from './stimulus-intake.service';
import { StimulusStoreService } from './stimulus-store.service';
import { SurfaceOrchestration } from './surface-orchestration.service';

/**
 * The STIMULUS seam — the intake pipeline both edges (chat + events) flow through:
 *
 *  - `StimulusIntake` — the single entry point; exposes `intakeEvent` / `intakeChat`.
 *  - `EventFilterService` — the mechanical (no-LLM) dedup + rate-limit on events.
 *  - `StimulusStoreService` — notification-seeds-a-thread persistence (threads/messages/stimuli on the
 *    'app' connection).
 *  - `ProjectRoutingService` — gateway identifier (`owner/repo`) → a connected `repos` row (exported so
 *    each `NotificationSource` adapter routes through it).
 *  - `ChatStimulusBridge` — subscribes the bound `CHAT_SURFACE.inbound$`, maps chat → a typed `Message`,
 *    feeds intake (and connects the surface on boot).
 *
 * The `BRAIN_SINK` the intake injects is bound by the @Global `BrainModule` (the thread brain: chat →
 * its session, event → a harness-message delivery). The `LoggingBrainSink` stays as an exported no-op
 * fallback for headless composition.
 *
 * Exports the intake + routing so the `ingress/` adapters/controllers depend only on these seams (not the
 * store internals). The `CHAT_SURFACE` it injects comes from the @Global `SurfaceModule`.
 */
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
  exports: [
    StimulusIntake,
    ProjectRoutingService,
    StimulusStoreService,
    DeliveryPump,
  ],
})
export class StimulusModule {}
