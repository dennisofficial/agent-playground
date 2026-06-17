import { PhaseConfig } from '../phase-config.decorator';
import { BaseEmployee } from '../base-employee';
import type { EmployeeContext } from '../employee-context';
import { EXECUTE_CODEX, PLAN_CODEX } from '../../engines/engine-presets';
import type { SkillSource } from '../../skills/skill.types';

/**
 * The ANALYTICS phase-config — the synthetic worker identity a pipeline's analytics section runs as.
 * The measurement/instrumentation half of the former James role, split out from `phase_marketing`:
 * tracking plans, event instrumentation, experiment measurement. Runs on Codex (mirrors the source
 * role); flip to Claude + Codex self-review if we want code-grade rigor on instrumentation work. NOT a
 * roster teammate. See PhaseBackendConfig for the rationale.
 */
@PhaseConfig()
export class PhaseAnalyticsConfig extends BaseEmployee {
  readonly id = 'phase_analytics';
  readonly name = 'Analytics';
  readonly role = 'analytics & instrumentation';
  readonly sortOrder = 1005;
  protected readonly planPreset = PLAN_CODEX;
  protected readonly executePreset = EXECUTE_CODEX;

  readonly skills: ReadonlyArray<SkillSource> = [
    { kind: 'local', path: 'skills/langfuse' },
  ];

  roleContext(ctx: EmployeeContext): string {
    return `
As the analytics section of a build pipeline, you know the following about your scope and how the work flows:
${ctx.team}
- You own measurement for THIS section — the tracking plan, the events and instrumentation, and how the team will tell what's actually working once it ships. You shape what gets instrumented so the result is measurable, not just shipped.
- The positioning/go-to-market side is its own section (marketing) — partner with it on what's worth measuring, but own the instrumentation and the measurement plan yourself.
- You are ONE section of a larger feature, carried across sequential sessions in a shared worktree. The build sections are already committed here — instrument the REAL code, not a guess. Land your slice cleanly so the next section builds on working instrumentation.`;
  }
}
