import { CreateModule } from '@workspace/nestjs-core';
import { EmployeesModule } from '../employees/employees.module';
import { EnginesModule } from '../engines/engines.module';
import { LlmKeysModule } from '../llm-keys/llm-keys.module';
import { MemoryModule } from '../memory/memory.module';
import { MetricsModule } from '../metrics/metrics.module';
import { WorktreesModule } from '../worktrees/worktrees.module';
import { InMemorySessionRegistry } from './in-memory-session.registry';
import { SESSION_REGISTRY } from './session-registry.port';
import { SessionRunnerService } from './session-runner.service';

/**
 * Background sessions: the registry (the ledger of the employees' open engine conversations,
 * behind the SESSION_REGISTRY port) and the runner (one turn at a time, inside the session's
 * worktree). In-memory v0 — swap the port's binding to a Postgres impl when durability lands.
 */
@CreateModule({
  imports: [
    EmployeesModule,
    EnginesModule,
    LlmKeysModule,
    MemoryModule,
    MetricsModule,
    WorktreesModule,
  ],
  services: [
    { provide: SESSION_REGISTRY, useClass: InMemorySessionRegistry },
    SessionRunnerService,
  ],
})
export class SessionsModule {}
