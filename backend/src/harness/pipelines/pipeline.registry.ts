import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EmployeeRegistry } from '../employees/employee.registry';
import { PIPELINE_DEFINITIONS, PipelineDefinition, StageMode } from './pipeline.types';

const KNOWN_MODES = new Set<string>(['plan', 'execute', 'investigate'] satisfies StageMode[]);
const KNOWN_GATES = new Set(['plan', 'pr']);

/**
 * Boot-validated registry of pipeline definitions. Mirrors the validation style of EmployeeRegistry:
 * any misconfiguration throws at module init, never silently at runtime.
 */
@Injectable()
export class PipelineRegistry implements OnModuleInit {
  private definitions: PipelineDefinition[] = [];

  constructor(
    private readonly employees: EmployeeRegistry,
    @Inject(PIPELINE_DEFINITIONS) private readonly rawDefinitions: PipelineDefinition[],
  ) {}

  onModuleInit() {
    if (!this.rawDefinitions || this.rawDefinitions.length === 0) {
      throw new Error(
        'No pipeline definitions provided — bind at least one PipelineDefinition to PIPELINE_DEFINITIONS',
      );
    }

    const names = new Set<string>();
    for (const def of this.rawDefinitions) {
      if (!def.name || !def.name.trim()) {
        throw new Error('Pipeline definition has an empty or missing name');
      }
      if (names.has(def.name)) {
        throw new Error(`Duplicate pipeline name '${def.name}'`);
      }
      names.add(def.name);

      if (!def.stages || def.stages.length === 0) {
        throw new Error(`Pipeline '${def.name}' must have at least one stage`);
      }

      for (let i = 0; i < def.stages.length; i++) {
        const stage = def.stages[i];
        const stageRef = `Pipeline '${def.name}' stage[${i}]`;

        if (!stage.role || !stage.role.trim()) {
          throw new Error(`${stageRef} has an empty or missing role`);
        }
        if (this.employees.byId(stage.role) === undefined) {
          throw new Error(
            `${stageRef} references unknown employee id '${stage.role}' — register the employee first`,
          );
        }
        if (!KNOWN_MODES.has(stage.mode)) {
          throw new Error(
            `${stageRef} has unknown mode '${stage.mode}' — must be one of: plan, execute, investigate`,
          );
        }
        if (stage.gate !== undefined && !KNOWN_GATES.has(stage.gate)) {
          throw new Error(
            `${stageRef} has unknown gate '${stage.gate}' — must be 'plan' or 'pr'`,
          );
        }
      }
    }

    this.definitions = this.rawDefinitions;
  }

  /** Retrieve a pipeline by name, throwing if not found. */
  get(name: string): PipelineDefinition {
    const def = this.definitions.find((d) => d.name === name);
    if (!def) {
      throw new Error(
        `Unknown pipeline '${name}' — registered pipelines: ${this.definitions.map((d) => d.name).join(', ')}`,
      );
    }
    return def;
  }

  list(): PipelineDefinition[] {
    return this.definitions;
  }
}
