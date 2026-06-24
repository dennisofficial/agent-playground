import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  MessageEntity,
  RepoEntity,
  StimulusEntity,
  ThreadEntity,
} from '../persistence/entities';
import { ChatStimulusBridge } from './chat-stimulus.bridge';
import { EventFilterService } from './event-filter.service';
import { ProjectRoutingService } from './project-routing.service';
import { STIMULUS_CONSUMER } from './stimulus-consumer';
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
 *  - `ChatStimulusBridge` — subscribes the bound `CHAT_SURFACE.inbound$`, maps chat → `ChatStimulus`,
 *    feeds intake (and connects the surface on boot).
 *
 * The `STIMULUS_CONSUMER` the intake injects is bound by the @Global `BrainModule` (`StimulusRouter`,
 * which demuxes chat → the thread's brain session and event → `EventTriageService`). The
 * `LoggingStimulusConsumer` stays as an exported no-op fallback for headless composition.
 *
 * Exports the intake + routing so the `ingress/` adapters/controllers depend only on these seams (not the
 * store internals). The `CHAT_SURFACE` it injects comes from the @Global `SurfaceModule`.
 *
 * NOTE — slated for rework: the `Stimulus` union + consumer-port + router demux are leftover indirection
 * from the single-central-brain era. See `../ARCHITECTURE.md` §7.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [RepoEntity, ThreadEntity, MessageEntity, StimulusEntity],
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
  ],
  exports: [StimulusIntake, ProjectRoutingService],
})
export class StimulusModule {}
