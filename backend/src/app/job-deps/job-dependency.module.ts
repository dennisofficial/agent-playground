import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobDependencyEntity, JobEntity } from '../persistence/entities';
import { JobDependencyService } from './job-dependency.service';

/**
 * JOB DEPENDENCIES — job-to-job "blocked by" edges + the wake funnel. `@Global` (like `TicketsModule`)
 * so the brain (Step 3 tools) and any driver-side caller can inject `JobDependencyService` without an
 * import edge. `BrainGateway` (the wake seam) comes from the `@Global` `BrainGatewayModule`, already
 * registered in `FeaturesModule` — no import needed here.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([JobDependencyEntity, JobEntity], DB_CONNECTION)],
  providers: [JobDependencyService],
  exports: [JobDependencyService],
})
export class JobDependencyModule {}
