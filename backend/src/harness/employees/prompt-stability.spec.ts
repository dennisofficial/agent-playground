import { describe, expect, it } from 'vitest';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import type { BaseEmployee } from './base-employee';
import type { EmployeeContext } from './employee-context';
import { AlexEmployee } from './roster/alex.employee';
import { JamesEmployee } from './roster/james.employee';
import { MayaEmployee } from './roster/maya.employee';
import { NoraEmployee } from './roster/nora.employee';
import { RileyEmployee } from './roster/riley.employee';
import { AtlasEmployee } from './roster/atlas.employee';
import { TEAM_CONTEXT } from './roster/shared';

/**
 * Cache-breakpoint guard: `chatPrompt`/`workerPrompt` render on every LLM step under a
 * `cache_control: ephemeral` breakpoint, so their bytes must be byte-stable for a given employee. This
 * snapshot pins the EXACT rendered output for every roster teammate across all three engines — captured
 * before the prompt-template refactor and asserted unchanged after it. A diff here means the cache busts.
 */

// A FIXED context so the snapshot is deterministic (the only thing that must match before/after is the
// employee builders, not the live roster). Real `TEAM_CONTEXT`, a representative roster line.
const CTX: EmployeeContext = {
  team: TEAM_CONTEXT,
  roster:
    'Alex — backend engineer; Riley — frontend engineer; Maya — product designer; ' +
    'James — marketing & analytics; Nora — researcher; Atlas — team lead',
};

const EMPLOYEES: Array<new () => BaseEmployee> = [
  AlexEmployee,
  JamesEmployee,
  MayaEmployee,
  NoraEmployee,
  RileyEmployee,
  AtlasEmployee,
];

const ENGINES = [
  EWorkerEngineName.LANGGRAPH,
  EWorkerEngineName.CLAUDE,
  EWorkerEngineName.CODEX,
];

describe('employee prompt byte-stability', () => {
  for (const Employee of EMPLOYEES) {
    const emp = new Employee();
    it(`${emp.id} chatPrompt is byte-stable`, () => {
      expect(emp.chatPrompt(CTX)).toMatchSnapshot();
    });
    for (const engine of ENGINES) {
      it(`${emp.id} workerPrompt(${engine}) is byte-stable`, () => {
        // workerPrompt is protected — it's the same surface engineSpec() builds from.
        const prompt = (
          emp as unknown as {
            workerPrompt: (
              ctx: EmployeeContext,
              opts: { engine: EWorkerEngineName },
            ) => string;
          }
        ).workerPrompt(CTX, { engine });
        expect(prompt).toMatchSnapshot();
      });
    }
  }
});
