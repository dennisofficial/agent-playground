import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  AtlasChannel,
  AtlasMessage,
  AtlasProject,
  AtlasStimulus,
  AtlasThread,
} from '../persistence/entities';
import { ChatStimulusBridge } from './chat-stimulus.bridge';
import { EventFilterService } from './event-filter.service';
import { ProjectRoutingService } from './project-routing.service';
import { STIMULUS_CONSUMER } from './stimulus-consumer';
import { StimulusIntake } from './stimulus-intake.service';
import { StimulusStoreService } from './stimulus-store.service';
import { SurfaceOrchestration } from './surface-orchestration.service';

/**
 * The Atlas v2 STIMULUS seam — where both edges converge into one currency and reach the brain:
 *
 *  - `StimulusIntake` — the single injectable normalized stimuli flow into; exposes `intakeEvent` /
 *    `intakeChat`. W3's triage plugs in by binding `STIMULUS_CONSUMER`.
 *  - `EventFilterService` — the mechanical (no-LLM) dedup + rate-limit on events.
 *  - `StimulusStoreService` — notification-seeds-a-thread persistence (threads/messages/stimuli on the
 *    'atlas' connection).
 *  - `ProjectRoutingService` — gateway identifier → `atlas_projects` → 1:1 `atlas_channels` (exported
 *    so each `NotificationSource` adapter routes through it).
 *  - `ChatStimulusBridge` — subscribes the bound `CHAT_SURFACE.inbound$`, maps chat → `ChatStimulus`,
 *    feeds intake (and connects the surface on boot).
 *
 * The `STIMULUS_CONSUMER` the intake injects is provided by W3's @Global `BrainModule` (its
 * `TriageService`) — the single binding the seam was designed for. W2's `LoggingStimulusConsumer` stays
 * as an exported fallback class for headless / no-brain composition, but is no longer bound here so the
 * brain's binding is the one `StimulusIntake` resolves (a module-local default would shadow the global).
 *
 * Exports the intake + routing so the `ingress/` adapters/controllers depend only on these seams (not
 * the store internals). The `CHAT_SURFACE` it injects comes from the @Global `SurfaceModule`. Zero v1
 * imports.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [AtlasProject, AtlasChannel, AtlasThread, AtlasMessage, AtlasStimulus],
      ATLAS_CONNECTION,
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
