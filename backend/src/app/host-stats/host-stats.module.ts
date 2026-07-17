import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { HostStatsSampleEntity } from '../persistence/entities';
import { HostStatsRecorderService } from './host-stats-recorder.service';
import { HostStatsSampleRepository } from './host-stats-sample.repository';
import { HostStatsController } from './host-stats.controller';
import { HostStatsService } from './host-stats.service';

@Module({
  imports: [TypeOrmModule.forFeature([HostStatsSampleEntity], DB_CONNECTION)],
  controllers: [HostStatsController],
  providers: [HostStatsService, HostStatsSampleRepository, HostStatsRecorderService],
})
export class HostStatsModule {}
