import { CreateModule } from '@workspace/nestjs-core';
import { EmployeesModule } from '../employees/employees.module';
import { EnginesModule } from '../engines/engines.module';
import { MemoryModule } from '../memory/memory.module';
import { InMemoryJobRegistry } from './in-memory-job.registry';
import { JOB_REGISTRY } from './job-registry.port';
import { WorkerService } from './worker.service';

/**
 * Background jobs: the registry (the ledger of engine sessions, behind the JOB_REGISTRY port) and
 * the worker (runs a job to completion on its engine). In-memory v0 — swap the port's binding to a
 * Postgres/BullMQ impl when durability/multi-process lands.
 */
@CreateModule({
  imports: [EmployeesModule, EnginesModule, MemoryModule],
  services: [{ provide: JOB_REGISTRY, useClass: InMemoryJobRegistry }, WorkerService],
})
export class JobsModule {}
