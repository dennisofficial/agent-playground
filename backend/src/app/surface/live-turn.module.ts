import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  TranscriptMessageEntity,
  ThreadGroupEntity,
  SubagentEntity,
  TaskEntity,
  ThreadEntity,
} from '../persistence/entities';
import { LiveTurnStore } from './live-turn-store';
import { ThreadInputService } from './thread-input.service';
import {
  BLOCK_SINK,
  EntitySubagentStore,
  EntityTaskEventSink,
  MessageBlockSink,
  SUBAGENT_STORE,
  TASK_EVENT_SINK,
  TurnHarnessFactory,
} from './turn-harness.service';

/**
 * @Global module for the shared transcript spine — {@link LiveTurnStore} (the resumable/durable live-stream
 * buffer) + {@link TurnHarnessFactory} (converts an engine turn's event stream into live frames + durable
 * blocks). Global so EVERY producer injects the SAME singletons with no module cycle: the brain
 * (`AgentSessionManager`) and the build driver (`ThreadDriver`) both build a harness; the web SSE controller
 * replays snapshots. The {@link BLOCK_SINK} is a narrow durable-block writer ({@link MessageBlockSink}), and
 * {@link TASK_EVENT_SINK} a narrow `tasks`-column writer ({@link EntityTaskEventSink}), so the driver rides
 * the spine without depending on the whole brain module.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [TranscriptMessageEntity, ThreadEntity, ThreadGroupEntity, TaskEntity, SubagentEntity],
      DB_CONNECTION,
    ),
  ],
  providers: [
    LiveTurnStore,
    MessageBlockSink,
    { provide: BLOCK_SINK, useExisting: MessageBlockSink },
    EntityTaskEventSink,
    { provide: TASK_EVENT_SINK, useExisting: EntityTaskEventSink },
    EntitySubagentStore,
    { provide: SUBAGENT_STORE, useExisting: EntitySubagentStore },
    TurnHarnessFactory,
    ThreadInputService,
  ],
  exports: [
    LiveTurnStore,
    TurnHarnessFactory,
    BLOCK_SINK,
    TASK_EVENT_SINK,
    SUBAGENT_STORE,
    ThreadInputService,
  ],
})
export class LiveTurnModule {}
