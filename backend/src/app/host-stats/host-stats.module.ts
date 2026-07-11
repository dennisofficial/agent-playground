import { Module } from '@nestjs/common';
import { HostStatsController } from './host-stats.controller';
import { HostStatsService } from './host-stats.service';

/**
 * `GET /web/host-stats` — a live snapshot of the host box (CPU/RAM/disk/containers/Docker disk).
 * `CONTAINER_ENGINE` is `@Global`-exported from `SandboxModule`, so no imports are needed here.
 */
@Module({
  controllers: [HostStatsController],
  providers: [HostStatsService],
})
export class HostStatsModule {}
