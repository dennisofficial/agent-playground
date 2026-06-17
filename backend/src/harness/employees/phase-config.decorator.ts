import { Injectable } from '@nestjs/common';

export const PHASE_CONFIG_METADATA = Symbol('PHASE_CONFIG');

/**
 * Marks an injectable class as a PHASE-CONFIG — a synthetic WORKER identity (a capability bundle:
 * engines + scoped skills/MCP + a section-typed worker prompt) that pipeline stages run as. NOT a
 * roster teammate.
 *
 * `EmployeeRegistry` discovers these into a list SEPARATE from the chat roster: a phase-config is
 * resolvable by id (`byId`) and gets a per-engine skill/MCP home provisioned (`provisionable()`), but
 * it NEVER appears in `list()` (the live chat roster the conductor schedules/classifies), the roster
 * summary, or addressing — so it can't become a phantom channel participant. Register the class in
 * `EmployeesModule.providers` as a PLAIN CLASS provider, exactly like an `@AIEmployee()`.
 */
export const PhaseConfig = (): ClassDecorator => (target) => {
  Injectable()(target);
  Reflect.defineMetadata(PHASE_CONFIG_METADATA, true, target);
};
