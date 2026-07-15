/**
 * prompt-kit / groups / autonomy — announces AUTONOMOUS MODE when per-job auto-approve is ON.
 *
 * CONDITIONAL on `ctx.settings.autoApproveMode` (any value but 'off'); absent when off, so the assembled
 * prompt is byte-identical to the normal brain. The copy is derived from WHICH gate(s) the mode covers
 * ('plan' | 'ship' | 'both'), so the brain is only told to verify harder at the gate(s) that actually
 * auto-advance. Ordered 1250 — in the approval-context band (after planning ≤1240, before job-kind 1900).
 */
import { Agent } from '../agent';
import { modeApprovesPlan, modeApprovesShip } from '@workspace/shared';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { hasAutoApprove } from '../conditions';
import type { PromptCtx } from '../prompt-ctx';

@FragmentGroup()
export class AutonomyGroup {
  /** Tell the brain it is running autonomously — the gate(s) this mode covers auto-advance, so it must
   *  self-verify harder there. */
  @Fragment({
    usedBy: [Agent.ATLAS_MAIN],
    order: 1250,
    condition: hasAutoApprove,
  })
  autonomousMode(ctx: PromptCtx): string {
    const mode = ctx.settings?.autoApproveMode ?? 'off';
    const approvesPlan = modeApprovesPlan(mode);
    const approvesShip = modeApprovesShip(mode);

    if (approvesPlan && approvesShip) {
      return [
        'AUTONOMOUS MODE — auto-approve is ON for this job. Your plan-approval and ship-review gates advance',
        'WITHOUT a human: `propose_plan` / `start_direct_build` dispatch the moment you call them, and a finished',
        'build ships without a "Ship it" click. No operator will catch a mistake at a gate — so verify HARDER',
        'before you propose or finalize: run the real live validation yourself, and only propose a plan / finalize',
        'a build you have actually exercised. Treat every gate as the point of no return it now is.',
      ].join('\n');
    }

    if (approvesPlan) {
      return [
        "AUTONOMOUS MODE (plan gate only) — auto-approve is ON for this job's plan-approval gate. Your",
        '`propose_plan` / `start_direct_build` dispatch the moment you call them WITHOUT a human. No operator will',
        'catch a mistake at that gate — so verify HARDER before you propose: run the real live validation yourself,',
        'and only propose a plan / direct build you have actually exercised. The ship-review gate is UNCHANGED —',
        'a finished build still waits for a human "Ship it" click.',
      ].join('\n');
    }

    return [
      "AUTONOMOUS MODE (ship gate only) — auto-approve is ON for this job's ship-review gate. A finished build",
      'ships WITHOUT a "Ship it" click the moment it reaches ship-review. No operator will catch a mistake at that',
      'gate — so verify HARDER before you finalize/ship: run the real live validation yourself, and only finalize',
      'a build you have actually exercised. The plan-approval gate is UNCHANGED — a proposed plan still waits for',
      'a human to approve it.',
    ].join('\n');
  }
}
