import { Injectable } from '@nestjs/common';
import { EmployeeRegistry } from './employee.registry';
import type { EmployeeContext } from './employee-context';
import type { EmployeeDefinition } from './employee.types';

/**
 * A bot's identity — one self with two surfaces. The chat interface (in the team's #dev channel) and
 * the background-execution thread share the same identity core; the "worker" is not a separate
 * persona, it's the same bot doing the work itself in the background.
 *
 * The prompt TEXT (shared scaffolding + the chat/worker skeletons) lives in `persona.prompts.ts`; the
 * per-employee facts live in the `@AIEmployee` definitions and are assembled by `base-employee.ts`.
 * This service is the thin `EmployeeContext` PROVIDER + a delegating `chatPromptFor` the bot-graph
 * already calls.
 */
@Injectable()
export class PersonaService {
  constructor(private readonly employees: EmployeeRegistry) {}

  /** The injected context every builder takes — delegates to the registry (single source). */
  context(): EmployeeContext {
    return this.employees.context();
  }

  /** The conversation-layer system prompt for an employee (delegates to its builder). */
  chatPromptFor(employee: EmployeeDefinition): string {
    return employee.chatPrompt(this.context());
  }
}
