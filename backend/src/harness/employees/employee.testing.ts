import type { Type } from '@nestjs/common';
import {
  EXECUTE_CLAUDE,
  EXECUTE_CODEX,
  INVESTIGATE_CLAUDE_MODEL,
  PLAN_CLAUDE,
  PLAN_CODEX,
} from '../engines/engine-presets';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import type { IHarnessTool } from '../tools/tool.types';
import type { Capability } from './capability';
import type { EmployeeDefinition } from './employee.types';

/**
 * Test-only factory for an `EmployeeDefinition` double. Returns a PLAIN object with method-valued
 * builder fields (so it stays spreadable: `makeEmployee({ ...over, protocols })`), satisfying the
 * builder-based interface without standing up a full `BaseEmployee`. Source services under test read
 * only declarative fields + builders; the prompts here are stubs.
 */
export interface FakeEmployeeOverrides {
  id?: string;
  name?: string;
  role?: string;
  sortOrder?: number;
  teamLead?: boolean;
  personality?: string;
  protocols?: ReadonlyArray<string>;
  tools?: ReadonlyArray<Type<IHarnessTool>>;
  /** Convenience: sets BOTH plan and execute presets to this engine (default Claude). */
  engine?: EWorkerEngineName;
  /** Stub role-knowledge string the `roleContext` builder returns. */
  roleContext?: string;
  capabilities?: Capability[];
}

export const makeEmployee = (
  over: FakeEmployeeOverrides = {},
): EmployeeDefinition => {
  const name = over.name ?? 'Alex';
  const engine = over.engine ?? EWorkerEngineName.CLAUDE;
  const planPreset =
    engine === EWorkerEngineName.CODEX ? PLAN_CODEX : PLAN_CLAUDE;
  const execPreset =
    engine === EWorkerEngineName.CODEX ? EXECUTE_CODEX : EXECUTE_CLAUDE;
  const roleContext = over.roleContext ?? 'ctx';
  const caps = over.capabilities ?? [];
  return {
    id: over.id ?? 'alex',
    name,
    role: over.role ?? 'backend engineer',
    sortOrder: over.sortOrder ?? 10,
    teamLead: over.teamLead,
    personality: over.personality,
    protocols: over.protocols,
    tools: over.tools,
    roleContext: () => roleContext,
    chatPrompt: () => `persona for ${name}`,
    planEngine: () => ({ ...planPreset, systemPrompt: `worker:${name}` }),
    executeEngine: () => ({ ...execPreset, systemPrompt: `worker:${name}` }),
    investigateEngine: () => ({
      ...execPreset,
      // Mirror BaseEmployee: Claude investigations override model only; Codex keeps the exec preset.
      ...(engine === EWorkerEngineName.CODEX
        ? {}
        : { model: INVESTIGATE_CLAUDE_MODEL }),
      systemPrompt: `worker:${name}`,
    }),
    capabilities: () => caps,
  };
};
