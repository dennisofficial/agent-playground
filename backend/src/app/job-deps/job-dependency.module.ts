import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobDependencyEntity, JobEntity } from '../persistence/entities';
import { StimulusModule } from '../stimulus/stimulus.module';
import { JobDependencyService } from './job-dependency.service';

/**
 * JOB DEPENDENCIES — job-to-job "blocked by" edges + the wake funnel. `@Global` so the brain (Step 3
 * tools) and any driver-side caller can inject `JobDependencyService` without an import edge.
 * `BrainGateway` (the wake seam) comes from the `@Global` `BrainGatewayModule`, already registered in
 * `FeaturesModule` — no import needed here. `StimulusModule` (non-@Global) provides `StimulusStoreService`,
 * which records the queued block/unblock context seeds; no import cycle (the stimulus/job-bootstrap trees
 * never reach back into JobDependency).
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([JobDependencyEntity, JobEntity], DB_CONNECTION),
    StimulusModule,
  ],
  providers: [JobDependencyService],
  exports: [JobDependencyService],
})
export class JobDependencyModule {}
