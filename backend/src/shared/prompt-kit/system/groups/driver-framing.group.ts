import { Agent } from '../agent';
import { jobKindIs } from '../conditions';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { CLOUD_SANDBOX_NOTE, SOLE_AUTHOR_NOTE } from '../fragments';
import { jobKindFragment } from '../job-kind';

const DRIVER = [Agent.WORKER];

@FragmentGroup()
export class DriverFramingGroup {
  @Fragment({ usedBy: DRIVER, order: 200 })
  cloudSandbox(): string {
    return CLOUD_SANDBOX_NOTE;
  }

  @Fragment({ usedBy: DRIVER, order: 201 })
  soleAuthor(): string {
    return SOLE_AUTHOR_NOTE;
  }

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
