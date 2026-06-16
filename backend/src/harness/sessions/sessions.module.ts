import { CreateModule } from '@workspace/nestjs-core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session, SessionEvent } from '@workspace/shared/schemas';
import { EmployeesModule } from '../employees/employees.module';
import { EnginesModule } from '../engines/engines.module';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { LlmKeysModule } from '../llm-keys/llm-keys.module';
import { MemoryModule } from '../memory/memory.module';
import { MetricsModule } from '../metrics/metrics.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { ProjectsModule } from '../projects/projects.module';
import { WorktreesModule } from '../worktrees/worktrees.module';
import { PipelineRunnerService } from './pipeline-runner.service';
import { PostgresSessionRegistry } from './postgres-session.registry';
import { ReviewPipelineService } from './review-pipeline.service';
import { SESSION_REGISTRY } from './session-registry.port';
import { SessionRunnerService } from './session-runner.service';

/**
 * Background sessions: the registry (the ledger of the employees' open engine conversations,
 * behind the SESSION_REGISTRY port) and the runner (one turn at a time, inside the session's
 * worktree). DURABLE: PostgresSessionRegistry persists session rows + the engine resume handle, so
 * sessions survive restarts (it reconciles interrupted `running` rows to 'failed' on boot). The
 * InMemorySessionRegistry stays in the tree as the v0 / unit-test double.
 */
@CreateModule({
  imports: [
    TypeOrmModule.forFeature([Session, SessionEvent]),
    EmployeesModule,
    EnginesModule,
    LifecycleModule,
    LlmKeysModule,
    MemoryModule,
    MetricsModule,
    PipelinesModule,
    ProjectsModule,
    WorktreesModule,
  ],
  services: [
    { provide: SESSION_REGISTRY, useClass: PostgresSessionRegistry },
    SessionRunnerService,
    ReviewPipelineService,
    PipelineRunnerService,
  ],
})
export class SessionsModule {}
