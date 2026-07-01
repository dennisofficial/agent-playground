import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { MessageEntity } from '../persistence/entities';
import { LiveTurnStore } from './live-turn-store';
import { BLOCK_SINK, MessageBlockSink, TurnHarnessFactory } from './turn-harness.service';

/**
 * @Global module for the shared transcript spine — {@link LiveTurnStore} (the resumable/durable live-stream
 * buffer) + {@link TurnHarnessFactory} (converts an engine turn's event stream into live frames + durable
 * blocks). Global so EVERY producer injects the SAME singletons with no module cycle: the brain
 * (`AgentSessionManager`) and the build driver (`ThreadDriver`) both build a harness; the web SSE controller
 * replays snapshots. The {@link BLOCK_SINK} is a narrow durable-block writer ({@link MessageBlockSink}) so
 * the driver rides the spine without depending on the whole brain module.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([MessageEntity], DB_CONNECTION)],
  providers: [
    LiveTurnStore,
    MessageBlockSink,
    { provide: BLOCK_SINK, useExisting: MessageBlockSink },
    TurnHarnessFactory,
  ],
  exports: [LiveTurnStore, TurnHarnessFactory, BLOCK_SINK],
})
export class LiveTurnModule {}
