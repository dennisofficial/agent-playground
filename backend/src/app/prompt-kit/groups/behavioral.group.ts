/**
 * prompt-kit / groups / behavioral — the brain's behavioral TAIL (baseline-first + spike-first), reused from
 * the shared `fragments.ts` catalog.
 *
 * NO jobKind condition — the layer applied to BOTH the normal and onboarding brain (both compose on audience
 * `brain`). Ordered `8000`/`8010` — a max band so these render LAST in either the normal or onboarding subset.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { BASELINE_FIRST_NOTE, SPIKE_FIRST_NOTE } from '../fragments';

@FragmentGroup()
export class BehavioralGroup {
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8000 })
  baselineFirst(): string {
    return BASELINE_FIRST_NOTE;
  }

  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8010 })
  spikeFirst(): string {
    return SPIKE_FIRST_NOTE;
  }
}
