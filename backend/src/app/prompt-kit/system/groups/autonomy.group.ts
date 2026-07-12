/**
 * prompt-kit / groups / autonomy — announces AUTONOMOUS MODE when per-job auto-approve is ON.
 *
 * CONDITIONAL on `ctx.settings.autoApprove`; absent when off, so the assembled prompt is byte-identical to
 * the normal brain. Ordered 1250 — in the approval-context band (after planning ≤1240, before job-kind 1900).
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { hasAutoApprove } from '../conditions';

@FragmentGroup()
export class AutonomyGroup {
  /** Tell the brain it is running autonomously — both gates auto-advance, so it must self-verify harder. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1250, condition: hasAutoApprove })
  autonomousMode(): string {
    return [
      'AUTONOMOUS MODE — auto-approve is ON for this job. Your plan-approval and ship-review gates advance',
      'WITHOUT a human: `propose_plan` / `start_direct_build` dispatch the moment you call them, and a finished',
      'build ships without a "Ship it" click. No operator will catch a mistake at a gate — so verify HARDER',
      'before you propose or finalize: run the real live validation yourself, and only propose a plan / finalize',
      'a build you have actually exercised. Treat every gate as the point of no return it now is.',
    ].join('\n');
  }
}
