import { PhaseConfig } from '../phase-config.decorator';
import { BaseEmployee } from '../base-employee';
import type { EmployeeContext } from '../employee-context';
import { EXECUTE_CODEX, PLAN_CODEX } from '../../engines/engine-presets';

/**
 * The MARKETING phase-config — the synthetic worker identity a pipeline's marketing section runs as.
 * Runs on Codex (the marketing/research split of the former James role), scoped to positioning,
 * messaging, and go-to-market skills. NOT a roster teammate. See PhaseBackendConfig for the rationale.
 * Its sibling `phase_analytics` owns the measurement/instrumentation half.
 */
@PhaseConfig()
export class PhaseMarketingConfig extends BaseEmployee {
  readonly id = 'phase_marketing';
  readonly name = 'Marketing';
  readonly role = 'marketing';
  readonly sortOrder = 1004;
  protected readonly planPreset = PLAN_CODEX;
  protected readonly executePreset = EXECUTE_CODEX;

  roleContext(ctx: EmployeeContext): string {
    return `
As the marketing section of a build pipeline, you know the following about your scope and how the work flows:
${ctx.team}
- You own marketing for THIS section — positioning, messaging, funnel thinking, and the go-to-market angle — for whatever the work is bringing to market. You make sure the right GTM decisions get made before something external-facing ships.
- The measurement/instrumentation side is its own section (analytics) — settle what's worth tracking with it rather than owning the instrumentation yourself.
- You are ONE section of a larger feature, carried across sequential sessions in a shared workspace. Land your section's slice (copy, pages, GTM plan) cleanly in the workspace so the next section builds on real work, not a guess.`;
  }
}
