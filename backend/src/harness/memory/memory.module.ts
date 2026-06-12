import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { Fact, Task, TeamTask, Worklog } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { EmployeesModule } from '../employees/employees.module';
import { CredentialContext } from '../llm-keys/credential-context';
import { LlmModule } from '../llm/llm.module';
import { BoardStore } from './board-store';
import { CheckpointerModule } from './checkpointer.module';
import { OpenAIEmbeddingProvider } from './embedding';
import { FetchService } from './fetch.service';
import { MemoryMetricsService } from './memory-metrics.service';
import { MemoryWriteService } from './memory-write.service';
import { ReconcileService } from './reconcile.service';
import { SemanticMemory } from './semantic-memory';
import { TaskStore } from './task-store';
import { WorklogStore } from './worklog-store';

/**
 * Long-term + working memory for the harness: the framework-light memory ports (semantic facts,
 * reminders, the team board, worklog) as injectable providers over TypeORM repositories, plus the
 * env-derived LangGraph checkpointer (per-bot chat threads in Postgres).
 *
 * Requires `DatabaseModule` (the @Global TypeORM connection) to be imported by the hosting app.
 */
@CreateModule({
  imports: [
    TypeOrmModule.forFeature([Fact, Task, TeamTask, Worklog]),
    LlmModule,
    EmployeesModule,
  ],
  // CHECKPOINTER lives in its own junction module (see checkpointer.module.ts for why);
  // re-exported here so existing importers of MemoryModule keep resolving the token.
  modules: [CheckpointerModule],
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
      provide: BoardStore,
      inject: [getRepositoryToken(TeamTask)],
      useFactory: (board: Repository<TeamTask>) => new BoardStore(board),
    },
    {
      provide: WorklogStore,
      inject: [getRepositoryToken(Worklog)],
      useFactory: (worklog: Repository<Worklog>) => new WorklogStore(worklog),
    },
  ],
})
export class MemoryModule {}
