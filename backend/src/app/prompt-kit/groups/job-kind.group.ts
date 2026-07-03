/**
 * prompt-kit / groups / job-kind — the "JOB KIND — …" orientation block that the legacy composer appended
 * via `jobKindFragment(kind)` (see `compose.ts`). Reproduced here as gated fragments so the assembled brain
 * prompt carries the same block. `onboarding` intentionally has NO fragment (`jobKindFragment('onboarding')`
 * is empty — the onboarding persona owns that framing).
 *
 * Ordered `19xx` — after all body fragments, before the behavioral tail (matching the composer's order).
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { jobKindFragment } from '../job-kind';
import type { PromptCtx } from '../prompt-ctx';

@FragmentGroup()
export class JobKindGroup {
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1900, condition: (c: PromptCtx) => c.jobKind === 'feature' })
  feature(): string {
    return jobKindFragment('feature');
  }

  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1901, condition: (c: PromptCtx) => c.jobKind === 'bugfix' })
  bugfix(): string {
    return jobKindFragment('bugfix');
  }

  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1902, condition: (c: PromptCtx) => c.jobKind === 'event' })
  event(): string {
    return jobKindFragment('event');
  }
}
