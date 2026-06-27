import { Global, Module } from '@nestjs/common';
import { RealtimeService } from './realtime.service';

/**
 * Realtime over Postgres logical replication (pg-realtime), in-process. @Global so the web surface
 * controller can inject `RealtimeService` for the cross-org `/web/threads/realtime` SSE endpoint without
 * an import edge. The engine lifecycle (start/stop) is owned by `RealtimeService`.
 */
@Global()
@Module({
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
