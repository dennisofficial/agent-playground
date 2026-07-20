import { Global, Module } from '@nestjs/common';
import { AppVersionService } from './app-version.service';
import { HealthController } from './health.controller';
import { LeaderElectionService } from './leader-election.service';

@Global()
@Module({
  controllers: [HealthController],
  providers: [LeaderElectionService, AppVersionService],
  exports: [LeaderElectionService, AppVersionService],
})
export class ClusterModule {}
