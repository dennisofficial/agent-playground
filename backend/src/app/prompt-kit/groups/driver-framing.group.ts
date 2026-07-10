/**
 * prompt-kit / groups / driver-framing — the SHARED framing for the in-sandbox WORKER persona: the
 * cloud-sandbox note, the sole-author invariant, and the job-kind block. ONE fragment each — kept as a
 * shared-audience group (`DRIVER = [Agent.WORKER]`) so re-adding a second driver persona is a one-line
 * `DRIVER` change.
 *
 * Orders sit AFTER the worker's body (100) and BEFORE its behavioral tail (400+).
 */
import { Agent } from '../agent';
import { jobKindIs } from '../conditions';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { CLOUD_SANDBOX_NOTE, SOLE_AUTHOR_NOTE } from '../fragments';
import { jobKindFragment } from '../job-kind';

const DRIVER = [Agent.WORKER];

@FragmentGroup()
export class DriverFramingGroup {
  /** The "you run in a cloud sandbox" framing (worker persona). */
  @Fragment({ usedBy: DRIVER, order: 200 })
  cloudSandbox(): string {
    return CLOUD_SANDBOX_NOTE;
  }

  /** The sole-author invariant — no phantom outside/concurrent editor (worker persona). */
  @Fragment({ usedBy: DRIVER, order: 201 })
  soleAuthor(): string {
    return SOLE_AUTHOR_NOTE;
  }

  /** The job-kind orientation block for the worker persona. */
  @Fragment({ usedBy: DRIVER, order: 300, condition: jobKindIs('feature') })
  feature(): string {
    return jobKindFragment('feature');
  }

  @Fragment({ usedBy: DRIVER, order: 301, condition: jobKindIs('bugfix') })
  bugfix(): string {
    return jobKindFragment('bugfix');
  }

  @Fragment({ usedBy: DRIVER, order: 302, condition: jobKindIs('event') })
  event(): string {
    return jobKindFragment('event');
  }
}
