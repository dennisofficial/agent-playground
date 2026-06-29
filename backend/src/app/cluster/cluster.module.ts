import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { LeaderElectionService } from './leader-election.service';

/**
 * CLUSTERING — Postgres advisory-lock leader election + health probes for graceful rolling deploys.
 * `@Global` so any module (driver/tickets/realtime/brain) can inject `LeaderElectionService` to gate its
 * singleton duties behind leadership without an import edge. Imported FIRST in `FeaturesModule` so the
 * election service is constructed early (though `onPromote` fires immediately when already leader, so
 * strict ordering isn't required).
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [LeaderElectionService],
  exports: [LeaderElectionService],
})
export class ClusterModule {}
