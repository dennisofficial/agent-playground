import { Agent } from '../agent';
import { hasAutoMerge } from '../conditions';
import { Fragment, FragmentGroup } from '../fragment.decorator';

@FragmentGroup()
export class AutoMergeGroup {
  @Fragment({
    usedBy: [Agent.PLANNING, Agent.CI],
    order: 1251,
    condition: hasAutoMerge,
  })
  autoMergeMode(): string {
    return [
      'AUTO-MERGE MODE — auto-merge is ON for this job. The moment your PR is mergeable and CI is green,',
      'it merges into its base branch WITHOUT a human at the final gate. Resolve merge conflicts and CI',
      'failures cleanly, verify your pushes actually go green before moving on, and never leave the PR in a',
      'half-fixed state expecting a human to catch it — there is no one there to catch it.',
    ].join('\n');
  }
}
