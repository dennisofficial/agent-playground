/**
 * prompt-kit / groups / behavioral — the brain's behavioral TAIL (baseline-first + author-live-validation +
 * spike-first + clarity-over-comments + minimal-code + ts-style + doc-version-verify), reused from the shared
 * `fragments.ts` catalog.
 *
 * NO jobKind condition — the layer applied to BOTH the normal and onboarding brain (both compose on audience
 * `brain`). The brain-only notes (`candor`/`baselineFirst`/`authorLiveValidation`) are ordered in the `8000`
 * max band so they render LAST in either the normal or onboarding subset. The FIVE shared code-authoring notes
 * (`spikeFirst`/`clarityOverComments`/`minimalCode`/`tsStyle`/`docVersionVerify`) are multi-audience: they also
 * target `WORKER` via a PER-AUDIENCE `order` map (brain `8000` band, worker `400` tail) so one fragment sits at
 * each persona's natural position. They ride here because the brain AUTHORS code on a direct build and on
 * onboarding script fixes (and shapes the plan the builders execute); they are the same house style the worker
 * orchestrator and fan-out writers carry.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import {
  AUTHOR_LIVE_VALIDATION_NOTE,
  BASELINE_FIRST_NOTE,
  CANDOR_NOTE,
  CLARITY_OVER_COMMENTS_NOTE,
  DOC_VERSION_VERIFY_NOTE,
  MINIMAL_CODE_NOTE,
  TS_STYLE_NOTE,
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

  /** PROVE IT BY RUNNING IT — the brain-authoring twin of the worker's VALIDATE_BY_RUNNING: the plan's
   *  `## Validation` and the brain's own direct builds must live-run, never "optional". */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 8005 })
  authorLiveValidation(): string {
    return AUTHOR_LIVE_VALIDATION_NOTE;
  }

  @Fragment({
    usedBy: [Agent.ATLAS_MAIN, Agent.WORKER],
    order: { [Agent.ATLAS_MAIN]: 8010, [Agent.WORKER]: 410 },
  })
  spikeFirst(): string {
    return (
      'SPIKE BEFORE YOU COMMIT to an approach that rests on an UNVERIFIED assumption — above all a claim about ' +
      'what an SDK, library, API, or tool can actually do ("does X support Y?", "can this be called ' +
      'mid-stream?"). A claim that something CANNOT be done — "not expressible", "not supported", "the library ' +
      'can\'t do this", so you reach for a workaround — is the MOST dangerous version of this and carries the ' +
      'HIGHEST burden of proof, not the lowest: you cannot prove a negative from memory, and "I don\'t recall a ' +
      'way" is not "there is no way". Treat any impossibility claim that would change your approach exactly like ' +
      '"does X support Y?" — verify it against the actual current docs/source for the installed version (or a ' +
      'spike) and CITE what you found (a doc URL or source path:line) before you let it steer the design; an ' +
      'uncited "can\'t" does not get to rule out a path. Rather than design several steps on top of a guess and ' +
      'discover the premise was false, write the smallest throwaway spike that calls the real thing and RUN it ' +
      'to prove the assumption first. A five-minute spike beats a derailed plan. Keep spikes in throwaway ' +
      'scratch space; never commit them.'
    );
  }

  @Fragment({
    usedBy: [Agent.ATLAS_MAIN, Agent.WORKER],
    order: { [Agent.ATLAS_MAIN]: 8020, [Agent.WORKER]: 415 },
  })
  clarityOverComments(): string {
    return CLARITY_OVER_COMMENTS_NOTE;
  }

  /** MINIMAL CODE — the brain authors plans + direct builds; a lean plan prevents over-building before any
   *  code is written. Same ladder the worker orchestrator and fan-out writers carry. */
  @Fragment({
    usedBy: [Agent.ATLAS_MAIN, Agent.WORKER],
    order: { [Agent.ATLAS_MAIN]: 8030, [Agent.WORKER]: 420 },
  })
  minimalCode(): string {
    return MINIMAL_CODE_NOTE;
  }

  /** TYPESCRIPT TYPE STYLE — the brain authors code on direct builds + onboarding script fixes; same house
   *  rule the worker orchestrator and fan-out writers carry. No-op on non-TS repos by its own wording. */
  @Fragment({
    usedBy: [Agent.ATLAS_MAIN, Agent.WORKER],
    order: { [Agent.ATLAS_MAIN]: 8040, [Agent.WORKER]: 421 },
  })
  tsStyle(): string {
    return TS_STYLE_NOTE;
  }

  /** VERIFY DOCS + INSTALLED VERSION before building on a dependency — the implementation-correctness twin of
   *  VERIFY_CURRENCY (which the brain carries in orientation). Shared with the worker + fan-out writers. */
  @Fragment({
    usedBy: [Agent.ATLAS_MAIN, Agent.WORKER],
    order: { [Agent.ATLAS_MAIN]: 8050, [Agent.WORKER]: 422 },
  })
  docVersionVerify(): string {
    return DOC_VERSION_VERIFY_NOTE;
  }
}
