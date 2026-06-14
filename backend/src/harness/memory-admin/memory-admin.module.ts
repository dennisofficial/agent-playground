import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { Fact } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { FactViewStore } from './fact-view.store';

/**
 * Slim, harness-free module composable by the api app for the admin Memory Viewer.
 * Exposes `FactViewStore` — a read-only god-view over the facts table.
 *
 * Zero imports from the rest of the harness: no LlmModule, no EmployeesModule, no
 * checkpointer. The only requirement is the host app's @Global `DatabaseModule` (the
 * TypeORM connection). Mirrors the `ProjectsModule` pattern.
 */
@CreateModule({
  imports: [TypeOrmModule.forFeature([Fact])],
  services: [
    {
      provide: FactViewStore,
      inject: [getRepositoryToken(Fact)],
      useFactory: (facts: Repository<Fact>) => new FactViewStore(facts),
    },
  ],
})
export class MemoryAdminModule {}
