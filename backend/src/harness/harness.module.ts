import { EnvService } from '@core/config/env/env.service';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Module } from '@nestjs/common';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Fact, Task, Worklog } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { createCheckpointer, pgConnString } from './memory/checkpointer';
import { OpenAIEmbeddingProvider } from './memory/embedding';
import { SemanticMemory } from './memory/semantic-memory';
import { TaskStore } from './memory/task-store';
import { WorklogStore } from './memory/worklog-store';

/** DI token for the working-memory LangGraph checkpointer (PostgresSaver), set up at module init. */
export const CHECKPOINTER = Symbol('HARNESS_CHECKPOINTER');

/**
 * The harness composition root. Turns the framework-light memory ports into injectable providers over
 * the TypeORM repositories + the env-derived checkpointer. The `ConductorService` (and the per-employee
 * invoker) get added here as the conductor/orchestration move lands — they inject these ports.
 *
 * Requires `DatabaseModule` (the @Global TypeORM connection) to be imported by the hosting app.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Fact, Task, Worklog])],
  providers: [
    {
      provide: SemanticMemory,
      inject: [getRepositoryToken(Fact)],
      useFactory: (facts: Repository<Fact>) => new SemanticMemory(facts, new OpenAIEmbeddingProvider()),
    },
    {
      provide: TaskStore,
      inject: [getRepositoryToken(Task)],
      useFactory: (tasks: Repository<Task>) => new TaskStore(tasks),
    },
    {
      provide: WorklogStore,
      inject: [getRepositoryToken(Worklog)],
      useFactory: (worklog: Repository<Worklog>) => new WorklogStore(worklog),
    },
    {
      provide: CHECKPOINTER,
      inject: [EnvService],
      useFactory: (env: EnvService): Promise<PostgresSaver> =>
        createCheckpointer(
          pgConnString({
            host: env.get('POSTGRES_HOST'),
            port: env.get('POSTGRES_PORT'),
            user: env.get('POSTGRES_USER'),
            password: env.get('POSTGRES_PASSWORD'),
            database: env.get('POSTGRES_DB'),
          }),
        ),
    },
  ],
  exports: [SemanticMemory, TaskStore, WorklogStore, CHECKPOINTER],
})
export class HarnessModule {}
