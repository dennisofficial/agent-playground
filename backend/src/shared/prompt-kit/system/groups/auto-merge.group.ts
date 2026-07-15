/**
 * prompt-kit / groups / auto-merge — announces AUTO-MERGE when per-job auto-merge is ON.
 *
 * CONDITIONAL on `ctx.settings.autoMerge`; absent when off, so the assembled prompt is byte-identical to
 * the normal brain. Ordered 1251 — right after `AutonomyGroup` (1250), in the same approval-context band
 * (1260 is `SandboxGroup.sandboxRuntime` — taken).
 */
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { hasAutoMerge } from '../conditions';
import { Agent } from '../agent';

@FragmentGroup()
export class AutoMergeGroup {
  /** Tell the brain a green, mergeable PR merges itself with no human at the final gate. */
  @Fragment({
    usedBy: [Agent.ATLAS_MAIN],
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
