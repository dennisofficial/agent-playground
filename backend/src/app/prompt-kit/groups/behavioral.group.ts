/**
 * prompt-kit / groups / behavioral — the brain's behavioral TAIL (baseline-first + spike-first +
 * clarity-over-comments + minimal-code), reused from the shared `fragments.ts` catalog.
 *
 * NO jobKind condition — the layer applied to BOTH the normal and onboarding brain (both compose on audience
 * `brain`). Ordered in the `8000` max band so these render LAST in either the normal or onboarding subset.
 * clarity-over-comments and minimal-code ride here because the brain AUTHORS code on a direct build and on
 * onboarding script fixes (and shapes the plan the builders execute); they are the same house style the
 * worker orchestrator and fan-out writers carry.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import {
  BASELINE_FIRST_NOTE,
  CANDOR_NOTE,
  CLARITY_OVER_COMMENTS_NOTE,
  MINIMAL_CODE_NOTE,
  SPIKE_FIRST_NOTE,
} from '../fragments';

@FragmentGroup()
export class BehavioralGroup {
  /** The calibrated-adviser / anti-sycophancy stance for the operator conversation. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 7990 })
  candor(): string {
    return CANDOR_NOTE;
  }

  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8000 })
  baselineFirst(): string {
    return BASELINE_FIRST_NOTE;
  }

  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8010 })
  spikeFirst(): string {
    return SPIKE_FIRST_NOTE;
  }

  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8020 })
  clarityOverComments(): string {
    return CLARITY_OVER_COMMENTS_NOTE;
  }

  /** MINIMAL CODE — the brain authors plans + direct builds; a lean plan prevents over-building before any
   *  code is written. Same ladder the worker orchestrator and fan-out writers carry. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8030 })
  minimalCode(): string {
    return MINIMAL_CODE_NOTE;
  }
}
