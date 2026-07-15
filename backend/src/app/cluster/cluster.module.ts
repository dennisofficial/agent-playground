import { Global, Module } from '@nestjs/common';
import { AppVersionService } from './app-version.service';
import { HealthController } from './health.controller';
import { LeaderElectionService } from './leader-election.service';

/**
 * CLUSTERING — Postgres advisory-lock leader election + health probes for graceful rolling deploys.
 * `@Global` so any module (driver/realtime/brain) can inject `LeaderElectionService` to gate its
 * singleton duties behind leadership without an import edge. Imported FIRST in `FeaturesModule` so the
 * election service is constructed early (though `onPromote` fires immediately when already leader, so
 * strict ordering isn't required). `AppVersionService` lives here too (not its own module) — it's a
 * single trivial accessor, and `@Global` lets analytics/transcript writers inject it with no import
 * edge, same reason `LeaderElectionService` is global.
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [LeaderElectionService, AppVersionService],
  exports: [LeaderElectionService, AppVersionService],
})
export class ClusterModule {}
