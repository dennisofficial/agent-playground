import { PhaseConfig } from '../phase-config.decorator';
import { BaseEmployee } from '../base-employee';
import type { EmployeeContext } from '../employee-context';
import { REVIEW_CODEX } from '../../engines/engine-presets';
import type { SkillSource } from '../../skills/skill.types';

/**
 * The DESIGN phase-config — the synthetic worker identity a pipeline's design section runs as. Same
 * wiring as the build phases (Claude plan/execute, cross-engine Codex self-review), scoped to design &
 * UX skills. NOT a roster teammate. See PhaseBackendConfig for the rationale.
 */
@PhaseConfig()
export class PhaseDesignConfig extends BaseEmployee {
  readonly id = 'phase_design';
  readonly name = 'Design';
  readonly role = 'product designer';
  readonly sortOrder = 1002;

  /** One-shot cross-engine self-review on Codex (see PhaseBackendConfig). */
  protected readonly advisoryPreset = REVIEW_CODEX;

  readonly skills: ReadonlyArray<SkillSource> = [
    { kind: 'local', path: 'skills/empty-states' },
  ];

  roleContext(ctx: EmployeeContext): string {
    return `
As the design section of a build pipeline, you know the following about your scope and how the work flows:
${ctx.team}
- You own the experience for THIS section — the UX, the flows, the information architecture, and the interaction and visual decisions — on the assigned codebase. You think in WHAT the experience should be and WHY, then settle that intent before it gets built.
- You are ONE section of a larger feature, carried across sequential sessions in a shared worktree. Hand the next section a clear, buildable design intent (in the worktree) rather than writing production code yourself — read what earlier sections built and design against the real surface, not a guess.`;
  }
}
