/**
 * prompt-kit / groups / job-kind — gated `@Fragment` methods (one per build `jobKind`) that emit the
 * "JOB KIND — …" orientation block for `Agent.ATLAS_MAIN`. `onboarding` intentionally has NO fragment
 * (`jobKindFragment('onboarding')` is empty — the onboarding persona owns that framing); same for `review`
 * (the ReviewGroup persona owns it).
 *
 * Ordered `19xx` — after all body fragments, before the behavioral tail.
 */
import { Agent } from '../agent';
import { jobKindIs } from '../conditions';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { jobKindFragment } from '../job-kind';

@FragmentGroup()
export class JobKindGroup {
  @Fragment({
    usedBy: [Agent.ATLAS_MAIN],
    order: 1900,
    condition: jobKindIs('feature'),
  })
  feature(): string {
    return jobKindFragment('feature');
  }

  @Fragment({
    usedBy: [Agent.ATLAS_MAIN],
    order: 1901,
    condition: jobKindIs('bugfix'),
  })
  bugfix(): string {
    return jobKindFragment('bugfix');
  }

  @Fragment({
    usedBy: [Agent.ATLAS_MAIN],
    order: 1902,
    condition: jobKindIs('event'),
  })
  event(): string {
    return jobKindFragment('event');
  }

  // NOTE: no `review` fragment here — a review job composes with the ReviewGroup persona (gated `isReview`),
  // which owns its framing (like onboarding). See `job-kind.ts` (`review: ''`).
}
