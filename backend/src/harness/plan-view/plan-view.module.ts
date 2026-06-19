import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { TeamTask } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { PlanViewStore } from './plan-view.store';

/**
 * Slim, harness-free module composable by the api app for the admin Plan Viewer.
 * Exposes `PlanViewStore` — a read-only view over the board / plan / pipeline tables.
 *
 * Zero imports from the rest of the harness: no LlmModule, no EmployeesModule, no checkpointer.
 * The only requirement is the host app's @Global `DatabaseModule` (the TypeORM connection).
 * Mirrors the `MemoryAdminModule` pattern.
 */
@CreateModule({
  imports: [TypeOrmModule.forFeature([TeamTask])],
  services: [
    {
      provide: PlanViewStore,
      inject: [getRepositoryToken(TeamTask)],
      useFactory: (tasks: Repository<TeamTask>) => new PlanViewStore(tasks),
    },
  ],
})
export class PlanViewModule {}
