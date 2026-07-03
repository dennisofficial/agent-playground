/**
 * prompt-kit / groups / driver-framing — the SHARED framing the legacy composer added to the in-sandbox
 * driver personas (worker + pr-review): the cloud-sandbox note and the job-kind block. ONE fragment each,
 * `usedBy` BOTH agents — this is the composer dedup the whole library exists for.
 *
 * Orders sit AFTER each persona's body (100) and BEFORE the worker's behavioral layer (400+), reproducing the
 * legacy order `body → CLOUD_SANDBOX → jobKind → layer` byte-for-byte.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { CLOUD_SANDBOX_NOTE } from '../fragments';
import { jobKindFragment } from '../job-kind';
import type { PromptCtx } from '../prompt-ctx';

const DRIVER = [Agent.WORKER, Agent.PR_REVIEW];

@FragmentGroup()
export class DriverFramingGroup {
  /** The "you run in a cloud sandbox" framing (composer FRAMING for worker + ship). */
  @Fragment({ usedBy: DRIVER, order: 200 })
  cloudSandbox(): string {
    return CLOUD_SANDBOX_NOTE;
  }

  /** The job-kind orientation block (composer injected `jobKindFragment` for worker + ship). */
  @Fragment({ usedBy: DRIVER, order: 300, condition: (c: PromptCtx) => c.jobKind === 'feature' })
  feature(): string {
    return jobKindFragment('feature');
  }

  @Fragment({ usedBy: DRIVER, order: 301, condition: (c: PromptCtx) => c.jobKind === 'bugfix' })
  bugfix(): string {
    return jobKindFragment('bugfix');
  }

  @Fragment({ usedBy: DRIVER, order: 302, condition: (c: PromptCtx) => c.jobKind === 'event' })
  event(): string {
    return jobKindFragment('event');
  }
}
