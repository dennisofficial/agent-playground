import { Global, Module } from '@nestjs/common';
import { RealtimeService } from './realtime.service';
import { SectionStampService } from './section-stamp.service';

/**
 * Realtime over Postgres logical replication (pg-realtime), in-process. @Global so the web surface
 * controller can inject `RealtimeService` for the cross-org `/web/threads/realtime` SSE endpoint without
 * an import edge. The engine lifecycle (start/stop) is owned by `RealtimeService`. `SectionStampService`
 * lives here too — it boot-reconciles the `jobs_stamp_section_entered` trigger that maintains
 * `JobEntity.section_first_entered`; nothing outside this module injects it, so it is not exported.
 */
@Global()
@Module({
  providers: [RealtimeService, SectionStampService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
