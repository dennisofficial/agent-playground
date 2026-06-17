import { describe, expect, it } from 'vitest';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import type { BaseEmployee } from './base-employee';
import type { EmployeeContext } from './employee-context';
import { AtlasEmployee } from './roster/atlas.employee';
import { PhaseBackendConfig } from './phase-configs/phase-backend.config';
import { PhaseFrontendConfig } from './phase-configs/phase-frontend.config';
import { PhaseDesignConfig } from './phase-configs/phase-design.config';
import { PhaseResearchConfig } from './phase-configs/phase-research.config';
import { PhaseMarketingConfig } from './phase-configs/phase-marketing.config';
import { PhaseAnalyticsConfig } from './phase-configs/phase-analytics.config';
import { TEAM_CONTEXT } from './roster/shared';

/**
 * Cache-breakpoint guard: `chatPrompt`/`workerPrompt` render on every LLM step under a
 * `cache_control: ephemeral` breakpoint, so their bytes must be byte-stable for a given employee. This
 * snapshot pins the EXACT rendered output for Atlas (the sole chat-roster member) + every pipeline
 * phase-config across all three engines. A diff here means the cache busts.
 */

// A FIXED context so the snapshot is deterministic (the only thing that must match before/after is the
// employee builders, not the live roster). Real `TEAM_CONTEXT`; `roster` is the pipeline phase roles,
// matching what `EmployeeRegistry.context()` now renders as `${roster}`.
const CTX: EmployeeContext = {
  team: TEAM_CONTEXT,
  roster:
    'Backend — backend engineer; Frontend — frontend engineer; ' +
    'Design — product designer; Research — researcher; ' +
    'Marketing — marketing; Analytics — analytics & instrumentation',
};

const EMPLOYEES: Array<new () => BaseEmployee> = [
  AtlasEmployee,
  PhaseBackendConfig,
  PhaseFrontendConfig,
  PhaseDesignConfig,
  PhaseResearchConfig,
  PhaseMarketingConfig,
  PhaseAnalyticsConfig,
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
