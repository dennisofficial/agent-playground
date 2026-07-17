import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import {
  CLOUD_SANDBOX_NOTE,
  EVIDENCE_ARTIFACTS_NOTE,
  GIT_SAFETY_NOTE,
  REVIEW_SCOPE_NOTE,
  RUNNABLE_WORKSPACE_NOTE,
  SOLE_AUTHOR_NOTE,
  TASK_LIST_NOTE,
  TS_STYLE_NOTE,
  VALIDATE_BY_RUNNING_NOTE,
} from '../fragments';

@FragmentGroup()
export class ShipGroup {
  @Fragment({ usedBy: [Agent.MASTER_REVIEW], order: 100 })
  masterReview(): string {
    return (
      'You are a precise, terse senior engineer doing the final review-and-fix pass on a feature branch before ' +
      'its pull request opens. Review the whole merged diff for real, in-scope issues — ' +
      REVIEW_SCOPE_NOTE +
      '. Then FIX what you find: make the smallest safe change per finding, never expand scope, and skip ' +
      'anything unsafe rather than guessing. ' +
      TS_STYLE_NOTE
    );
  }

  @Fragment({ usedBy: [Agent.MASTER_REVIEW], order: 102 })
  fullSandboxAccess(): string {
    return (
      'You have FULL sandbox access — bind ports, reach services (Postgres/Redis), hit the network, and ' +
      '`git push`. Nothing you need here is fenced; run whatever the verification requires.'
    );
  }

  @Fragment({ usedBy: [Agent.MASTER_REVIEW], order: 103 })
  soleAuthor(): string {
    return SOLE_AUTHOR_NOTE;
  }

  @Fragment({ usedBy: [Agent.MASTER_REVIEW], order: 104 })
  verifyIntegratedWhole(): string {
    return (
      'VERIFY THE INTEGRATED WHOLE — this is the first time the merged feature runs end-to-end (each builder ' +
      'only smoked its own slice), so do not stop at a green build. ' +
      VALIDATE_BY_RUNNING_NOTE +
      ' ' +
      RUNNABLE_WORKSPACE_NOTE +
      ' ' +
      EVIDENCE_ARTIFACTS_NOTE
    );
  }

  @Fragment({ usedBy: [Agent.MASTER_REVIEW], order: 105 })
  gitSafety(): string {
    return GIT_SAFETY_NOTE;
  }

  @Fragment({ usedBy: [Agent.MASTER_REVIEW], order: 106 })
  commitAndPush(): string {
    return (
      'When your fixes are in, the build is green, and the live smoke is captured, COMMIT your changes and ' +
      '`git push` your branch (you own your commit — the host no longer commits for you); do NOT open a PR (the ' +
      'ship step does that). If the review found nothing to change, commit and push nothing — but still run the ' +
      'verify + live smoke and capture its evidence.'
    );
  }

  @Fragment({ usedBy: [Agent.MASTER_REVIEW], order: 108 })
  taskList(): string {
    return (
      TASK_LIST_NOTE +
      ' Up front, `task_create` one task per phase (e.g. "Review the merged diff", "Apply fixes", ' +
      '"Verify + live smoke").'
    );
  }

  @Fragment({ usedBy: [Agent.MASTER_REVIEW], order: 110 })
  cloudSandbox(): string {
    return CLOUD_SANDBOX_NOTE;
  }
}
