import { PhaseConfig } from '../phase-config.decorator';
import { BaseEmployee } from '../base-employee';
import { deepResearchCapability } from '../capabilities/deep-research.capability';
import type { Capability } from '../capability';
import type { EmployeeContext } from '../employee-context';
import { EXECUTE_CODEX, PLAN_CODEX } from '../../engines/engine-presets';

/**
 * The RESEARCH phase-config — the synthetic worker identity a pipeline's research section runs as.
 * Runs on Codex (strong at live web search) and carries the discretionary deep-research capability, so
 * a research section can search the web and cite primary sources. NOT a roster teammate. See
 * PhaseBackendConfig for the rationale.
 */
@PhaseConfig()
export class PhaseResearchConfig extends BaseEmployee {
  readonly id = 'phase_research';
  readonly name = 'Research';
  readonly role = 'researcher';
  readonly sortOrder = 1003;
  protected readonly planPreset = PLAN_CODEX;
  protected readonly executePreset = EXECUTE_CODEX;

  roleContext(ctx: EmployeeContext): string {
    return `
As the research section of a build pipeline, you know the following about your scope and how the work flows:
${ctx.team}
- You own evidence for THIS section — competitor/market research, feature research (how a capability is done elsewhere, the trade-offs), and live fact-checking (most importantly, that the libraries, APIs, and tools the work relies on are used CORRECTLY against their CURRENT docs, not stale or hallucinated assumptions).
- You run on Codex, which can search the web and read primary sources directly — that's your edge: when something is unsure, go find out rather than guessing.
- ALWAYS cite. Every finding carries its source inline — a link plus the exact quote, figure, or API signature it rests on — never a bare conclusion. Label anything you could not confirm as unverified rather than stating it as fact.
- You are ONE section of a larger feature, carried across sequential sessions in a shared workspace. Land your findings as evidence the next section can build on (in the workspace), not production code.`;
  }

  /** Discretionary deep-research tool — opens a read-only research session on Codex. */
  capabilities(_ctx: EmployeeContext): Capability[] {
    return [deepResearchCapability((c) => this.engineSpec(c, this.planPreset))];
  }
}
