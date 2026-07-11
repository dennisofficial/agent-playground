import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { HostStatsSampleEntity } from '../persistence/entities';
import { HostStatsController } from './host-stats.controller';
import { HostStatsRecorderService } from './host-stats-recorder.service';
import { HostStatsSampleRepository } from './host-stats-sample.repository';
import { HostStatsService } from './host-stats.service';

/**
 * `GET /web/host-stats` — a live snapshot of the host box (CPU/RAM/disk/containers/Docker disk), plus
 * `GET .../realtime` (SSE push) and `GET .../history` (downsampled 24h from `host_stats_sample`).
 * `HostStatsRecorderService` persists snapshots on the leader; see it for the write side.
 * `CONTAINER_ENGINE` is `@Global`-exported from `SandboxModule`, and `LeaderElectionService`/`EnvService`
 * are both `@Global`, so no imports are needed for those here.
 */
@Module({
  imports: [TypeOrmModule.forFeature([HostStatsSampleEntity], DB_CONNECTION)],
  controllers: [HostStatsController],
  providers: [
    HostStatsService,
    HostStatsSampleRepository,
    HostStatsRecorderService,
  ],
})
export class HostStatsModule {}
