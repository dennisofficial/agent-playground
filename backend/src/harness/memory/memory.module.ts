import { EnvService } from '@core/config/env/env.service';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { Fact, Task, Worklog } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { EmployeesModule } from '../employees/employees.module';
import { CredentialContext } from '../llm-keys/credential-context';
import { LlmModule } from '../llm/llm.module';
import { createCheckpointer, pgConnString } from './checkpointer';
import { OpenAIEmbeddingProvider } from './embedding';
import { FetchService } from './fetch.service';
import { MemoryMetricsService } from './memory-metrics.service';
import { MemoryWriteService } from './memory-write.service';
import { ReconcileService } from './reconcile.service';
import { SemanticMemory } from './semantic-memory';
import { TaskStore } from './task-store';
import { WorklogStore } from './worklog-store';

/** DI token for the working-memory LangGraph checkpointer (PostgresSaver), set up at module init. */
export const CHECKPOINTER = Symbol('HARNESS_CHECKPOINTER');

/**
 * Long-term + working memory for the harness: the framework-light memory ports (semantic facts,
 * reminders, worklog) as injectable providers over TypeORM repositories, plus the env-derived
 * LangGraph checkpointer (per-bot chat threads in Postgres).
 *
 * Requires `DatabaseModule` (the @Global TypeORM connection) to be imported by the hosting app.
 */
@CreateModule({
  imports: [
    TypeOrmModule.forFeature([Fact, Task, Worklog]),
    LlmModule,
    EmployeesModule,
  ],
  services: [
    MemoryMetricsService,
    MemoryWriteService,
    FetchService,
    ReconcileService,
    {
      provide: SemanticMemory,
      inject: [getRepositoryToken(Fact), CredentialContext],
      useFactory: (facts: Repository<Fact>, creds: CredentialContext) =>
        new SemanticMemory(
          facts,
          new OpenAIEmbeddingProvider(() => creds.openaiKey()),
        ),
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
})
export class MemoryModule {}
