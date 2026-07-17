import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  SubagentEntity,
  TaskEntity,
  ThreadEntity,
  ThreadGroupEntity,
  TranscriptMessageEntity,
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
