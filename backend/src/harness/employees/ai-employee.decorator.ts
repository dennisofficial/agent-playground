import { Injectable } from '@nestjs/common';

export const AI_EMPLOYEE_METADATA = Symbol('AI_EMPLOYEE');

/**
 * Marks an injectable class as an AI employee (must implement `EmployeeDefinition`). Discovered by
 * `EmployeeRegistry` at boot — drop a decorated class into `roster/`, list it in
 * `EmployeesModule.providers` (plain class provider), and it's on the team.
 */
export const AIEmployee = (): ClassDecorator => (target) => {
  Injectable()(target);
  Reflect.defineMetadata(AI_EMPLOYEE_METADATA, true, target);
};
