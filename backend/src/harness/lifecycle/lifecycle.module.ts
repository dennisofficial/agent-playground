import { CreateModule } from '@workspace/nestjs-core';
import { EmployeesModule } from '../employees/employees.module';
import { PersonaService } from '../employees/persona.service';
import { LlmKeysModule } from '../llm-keys/llm-keys.module';
import { MemoryModule } from '../memory/memory.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SelfReviewHandler } from './handlers/self-review.handler';
import { LIFECYCLE_HANDLERS } from './lifecycle.handler';
import { EMPLOYEE_CONTEXT_PROVIDER, LifecycleRunner } from './lifecycle.runner';

/**
 * The engine-agnostic lifecycle-hook runner + its bindings. The context provider is PersonaService;
 * the handler set is collected here (SelfReviewHandler today). It deliberately does NOT import
 * SessionsModule — handlers stream progress via the payload's `onProgress` callback rather than the
 * session registry — so the session runner can import THIS module to emit `plan.finished` without a
 * cycle.
 *
 * Imports WorkspacesModule for the Phase-7 `TurnExecutor` seam (the self-review handler routes its two
 * engine runs through it). No cycle: WorkspacesModule imports neither LifecycleModule nor SessionsModule.
 */
@CreateModule({
  imports: [EmployeesModule, WorkspacesModule, MemoryModule, LlmKeysModule],
  services: [
    LifecycleRunner,
    SelfReviewHandler,
    { provide: EMPLOYEE_CONTEXT_PROVIDER, useExisting: PersonaService },
    {
      provide: LIFECYCLE_HANDLERS,
      useFactory: (selfReview: SelfReviewHandler) => [selfReview],
      inject: [SelfReviewHandler],
    },
  ],
})
export class LifecycleModule {}
