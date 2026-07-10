/**
 * prompt-kit / groups / behavioral — the brain's behavioral TAIL (baseline-first + author-live-validation +
 * spike-first + clarity-over-comments + minimal-code), reused from the shared `fragments.ts` catalog.
 *
 * The authoring fragments are gated out of `jobKind:'review'`: review jobs share the investigation/sandbox
 * framing, but their persona says they report an existing PR rather than author a plan or direct build.
 * Ordered in the `8000` max band so these render LAST in either the normal or onboarding subset.
 * clarity-over-comments and minimal-code ride here because the brain AUTHORS code on a direct build and on
 * onboarding script fixes (and shapes the plan the builders execute); they are the same house style the
 * worker orchestrator and fan-out writers carry.
 */
import { Agent } from '../agent';
import { notReview } from '../conditions';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import {
  AUTHOR_LIVE_VALIDATION_NOTE,
  BASELINE_FIRST_NOTE,
  CANDOR_NOTE,
  CLARITY_OVER_COMMENTS_NOTE,
  DOC_VERSION_VERIFY_NOTE,
  MINIMAL_CODE_NOTE,
  RUNNABLE_WORKSPACE_NOTE,
  SPIKE_FIRST_NOTE,
  TS_STYLE_NOTE,
} from '../fragments';

@FragmentGroup()
export class BehavioralGroup {
  /** The calibrated-adviser / anti-sycophancy stance for the operator conversation. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 7990 })
  candor(): string {
    return CANDOR_NOTE;
  }

  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8000, condition: notReview })
  baselineFirst(): string {
    return BASELINE_FIRST_NOTE;
  }

  /** PROVE IT BY RUNNING IT — the brain-authoring twin of the worker's VALIDATE_BY_RUNNING: the plan's
   *  `## Validation` and the brain's own direct builds must live-run, never "optional". */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8005, condition: notReview })
  authorLiveValidation(): string {
    return AUTHOR_LIVE_VALIDATION_NOTE;
  }

  /** A RUNNABLE WORKSPACE IS THE HAPPY PATH — the environment-side of verification for the brain: when the
   *  work can't be run because the env isn't ready, fix the workspace profile (request the secret, correct
   *  setup) or ask the operator and wait — never skip, never author a plan that validates against a stand-in. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8006, condition: notReview })
  runnableWorkspace(): string {
    return RUNNABLE_WORKSPACE_NOTE;
  }

  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8010, condition: notReview })
  spikeFirst(): string {
    return SPIKE_FIRST_NOTE;
  }

  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8020, condition: notReview })
  clarityOverComments(): string {
    return CLARITY_OVER_COMMENTS_NOTE;
  }

  /** MINIMAL CODE — the brain authors plans + direct builds; a lean plan prevents over-building before any
   *  code is written. Same ladder the worker orchestrator and fan-out writers carry. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8030, condition: notReview })
  minimalCode(): string {
    return MINIMAL_CODE_NOTE;
  }

  /** TYPESCRIPT TYPE STYLE — the brain authors code on direct builds + onboarding script fixes; same house
   *  rule the worker orchestrator and fan-out writers carry. No-op on non-TS repos by its own wording. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8040, condition: notReview })
  tsStyle(): string {
    return TS_STYLE_NOTE;
  }

  /** VERIFY DOCS + INSTALLED VERSION before building on a dependency — the implementation-correctness twin of
   *  VERIFY_CURRENCY (which the brain carries in orientation). Shared with the worker + fan-out writers. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8050, condition: notReview })
  docVersionVerify(): string {
    return DOC_VERSION_VERIFY_NOTE;
  }
}
