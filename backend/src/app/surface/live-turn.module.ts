import { Global, Module } from '@nestjs/common';
import { LiveTurnStore } from './live-turn-store';

/**
 * @Global module for the {@link LiveTurnStore} — the resumable/durable live-stream buffer. Global so BOTH
 * the brain (`AgentSessionManager`, the producer that pushes engine events) and the web SSE controller
 * (the consumer that replays a snapshot on connect) inject the SAME singleton, with no module cycle.
 */
@Global()
@Module({
  providers: [LiveTurnStore],
  exports: [LiveTurnStore],
})
export class LiveTurnModule {}
