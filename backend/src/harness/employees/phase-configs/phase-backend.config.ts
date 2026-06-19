import { PhaseConfig } from '../phase-config.decorator';
import { BaseEmployee } from '../base-employee';
import type { EmployeeContext } from '../employee-context';
import { REVIEW_CODEX } from '../../engines/engine-presets';
import type { SkillSource } from '../../skills/skill.types';

/**
 * The BACKEND phase-config — the synthetic worker identity a pipeline's backend section runs as. NOT
 * a roster teammate (no chat presence); resolvable by id and provisioned its own scoped skill/MCP
 * home so a backend session loads ONLY backend-relevant skills (tight scope = fewer hallucinations).
 *
 * Engine wiring deliberately mirrors the build engineers (Alex/Riley/Maya), NOT Atlas: it inherits
 * BaseEmployee's Claude plan/execute presets and declares the cross-engine Codex self-review, so its
 * plans get an independent challenge (Claude plans → Codex critiques). Atlas's own `PLAN_CODEX`/
 * `EXECUTE_CODEX` presets are NOT inherited — that would make the challenge same-engine.
 */
@PhaseConfig()
export class PhaseBackendConfig extends BaseEmployee {
  readonly id = 'phase_backend';
  readonly name = 'Backend';
  readonly role = 'backend engineer';
  // Irrelevant for a phase-config (never listed/sorted) — kept high so it can't be mistaken for a
  // roster slot if it ever leaks into a sort.
  readonly sortOrder = 1000;

  /** One-shot cross-engine self-review on Codex — an independent engine critiques the Claude-written
   * plan. The base `capabilities()` turns this preset into the `PlanFinished` self-review capability. */
  protected readonly advisoryPreset = REVIEW_CODEX;

  // Scoped capability: only backend-relevant skills load into this section's sessions. Starter set is
  // code-declared; the authoritative per-section mapping (remapped from the role→skill seeder grants)
  // lands later as DB grants keyed on `employee_id = 'phase_backend'` (the grant path is id-generic).
  readonly skills: ReadonlyArray<SkillSource> = [
    { kind: 'local', path: 'skills/env-conventions' },
  ];

  roleContext(ctx: EmployeeContext): string {
    return `
As the backend section of a build pipeline, you know the following about your scope and how the work flows:
${ctx.team}
- You own the server side for THIS section — APIs, services, data models, persistence, performance, and reliability — on the assigned codebase. You favor solid foundations: failure modes, data integrity, and what breaks under load.
- You are ONE section of a larger feature, carried across sequential sessions that all share the feature's ONE branch in this workstation. Build only your section's slice and commit it cleanly to that branch, so the next section builds against real, working code rather than a guess.`;
  }
}
