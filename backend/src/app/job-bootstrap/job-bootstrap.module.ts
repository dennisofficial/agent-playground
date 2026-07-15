/**
 * job-bootstrap / job-bootstrap.module — provides `JobBootstrapService.ensurePlanningThreadGroup`, the
 * create-if-absent seam every job-creation site calls right after inserting its `JobEntity` row (d7:
 * `thread_group_id` is never null, even for a pure-chat/onboarding job that never builds). `@Global` + its own
 * `TypeOrmModule.forFeature` (mirrors `ThreadGroupKindModule`) so the driver, surface, stimulus, and brain
 * modules can all depend on it without importing each other: `BrainModule` already imports
 * `StimulusModule`, so routing this through `BrainStoreService` instead would close a
 * `BrainModule → StimulusModule → BrainModule` cycle.
 */
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ThreadGroupEntity, ThreadEntity } from '../persistence/entities';
import { JobBootstrapService } from './job-bootstrap.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ThreadGroupEntity, ThreadEntity], DB_CONNECTION),
  ],
  providers: [JobBootstrapService],
  exports: [JobBootstrapService],
})
export class JobBootstrapModule {}
