import { ENGINEERING_STAGES } from '../agent';
import { jobKindIs } from '../conditions';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { jobKindFragment } from '../job-kind';

@FragmentGroup()
export class JobKindGroup {
  @Fragment({
    usedBy: ENGINEERING_STAGES,
    order: 1900,
    condition: jobKindIs('feature'),
  })
  feature(): string {
    return jobKindFragment('feature');
  }

  @Fragment({
    usedBy: ENGINEERING_STAGES,
    order: 1901,
    condition: jobKindIs('bugfix'),
  })
  bugfix(): string {
    return jobKindFragment('bugfix');
  }

  @Fragment({
    usedBy: ENGINEERING_STAGES,
    order: 1902,
    condition: jobKindIs('event'),
  })
  event(): string {
    return jobKindFragment('event');
  }

}
