import { PhaseConfig } from '../phase-config.decorator';
import { BaseEmployee } from '../base-employee';
import { selfReviewCapability } from '../capabilities/self-review.capability';
import type { Capability } from '../capability';
import type { EmployeeContext } from '../employee-context';
import { REVIEW_CODEX } from '../../engines/engine-presets';
import type { SkillSource } from '../../skills/skill.types';

/**
 * The FRONTEND phase-config — the synthetic worker identity a pipeline's frontend section runs as.
 * Same wiring as the backend phase (Claude plan/execute, cross-engine Codex self-review), scoped to
 * frontend-relevant skills. NOT a roster teammate. See PhaseBackendConfig for the rationale.
 */
@PhaseConfig()
export class PhaseFrontendConfig extends BaseEmployee {
  readonly id = 'phase_frontend';
  readonly name = 'Frontend';
  readonly role = 'frontend engineer';
  readonly sortOrder = 1001;

  readonly skills: ReadonlyArray<SkillSource> = [
    { kind: 'local', path: 'skills/empty-states' },
    { kind: 'local', path: 'skills/web-state-redux-toolkit' },
  ];

  roleContext(ctx: EmployeeContext): string {
    return `
As the frontend section of a build pipeline, you know the following about your scope and how the work flows:
${ctx.team}
- You own the client side for THIS section — UI, components, state, loading/empty/error states, and the wiring to the backend that earlier sections built. You make features feel solid and responsive.
- You are ONE section of a larger feature, carried across sequential sessions in a shared worktree. The backend is already built and committed here — read it and build the UI against the REAL contract, not a guess. Commit cleanly so the next section (or the redesign pass) builds on working code.`;
  }

  capabilities(_ctx: EmployeeContext): Capability[] {
    return [selfReviewCapability((c) => this.engineSpec(c, REVIEW_CODEX))];
  }
}
