import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, TurnModelUsageEntity, TurnStatsEntity } from '../persistence/entities';
import { TurnUsageProjector } from './turn-usage-projector.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([TurnStatsEntity, TurnModelUsageEntity, JobEntity], DB_CONNECTION),
  ],
  providers: [TurnUsageProjector],
  exports: [TurnUsageProjector],
})
export class AnalyticsModule {}
