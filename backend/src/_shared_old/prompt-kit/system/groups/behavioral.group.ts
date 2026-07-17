import { ENGINEERING_STAGES } from '../agent';
import { notReview } from '../conditions';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import {
  AUTHOR_LIVE_VALIDATION_NOTE,
  BASELINE_FIRST_NOTE,
  CANDOR_NOTE,
  CLARITY_OVER_COMMENTS_NOTE,
  DESIGN_DISCIPLINE_NOTE,
  DIAGRAM_FORMAT_NOTE,
  DOC_VERSION_VERIFY_NOTE,
  MINIMAL_CODE_NOTE,
  RUNNABLE_WORKSPACE_NOTE,
  SPIKE_FIRST_NOTE,
  TS_STYLE_NOTE,
} from '../fragments';

@FragmentGroup()
export class BehavioralGroup {
  @Fragment({ usedBy: ENGINEERING_STAGES, order: 7990 })
  candor(): string {
    return CANDOR_NOTE;
  }

  @Fragment({ usedBy: ENGINEERING_STAGES, order: 7991 })
  diagramFormat(): string {
    return DIAGRAM_FORMAT_NOTE;
  }

  @Fragment({ usedBy: ENGINEERING_STAGES, order: 8000, condition: notReview })
  baselineFirst(): string {
    return BASELINE_FIRST_NOTE;
  }

  @Fragment({ usedBy: ENGINEERING_STAGES, order: 8005, condition: notReview })
  authorLiveValidation(): string {
    return AUTHOR_LIVE_VALIDATION_NOTE;
  }

  @Fragment({ usedBy: ENGINEERING_STAGES, order: 8006, condition: notReview })
  runnableWorkspace(): string {
    return RUNNABLE_WORKSPACE_NOTE;
  }

  @Fragment({ usedBy: ENGINEERING_STAGES, order: 8010, condition: notReview })
  spikeFirst(): string {
    return SPIKE_FIRST_NOTE;
  }

  @Fragment({ usedBy: ENGINEERING_STAGES, order: 8020, condition: notReview })
  clarityOverComments(): string {
    return CLARITY_OVER_COMMENTS_NOTE;
  }

  @Fragment({ usedBy: ENGINEERING_STAGES, order: 8030, condition: notReview })
  minimalCode(): string {
    return MINIMAL_CODE_NOTE;
  }

  @Fragment({ usedBy: ENGINEERING_STAGES, order: 8031, condition: notReview })
  designDiscipline(): string {
    return DESIGN_DISCIPLINE_NOTE;
  }

  @Fragment({ usedBy: ENGINEERING_STAGES, order: 8040, condition: notReview })
  tsStyle(): string {
    return TS_STYLE_NOTE;
  }

  @Fragment({ usedBy: ENGINEERING_STAGES, order: 8050, condition: notReview })
  docVersionVerify(): string {
    return DOC_VERSION_VERIFY_NOTE;
  }
}
