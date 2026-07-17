import { modeApprovesPlan, modeApprovesShip } from '@workspace/shared';
import { Agent, SHIP_STAGES } from '../agent';
import { hasAutoApprove } from '../conditions';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import type { PromptCtx } from '../prompt-ctx';

@FragmentGroup()
export class AutonomyGroup {
  @Fragment({
    usedBy: [Agent.PLANNING],
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

  @Fragment({
    usedBy: SHIP_STAGES,
    order: 8033,
    condition: hasAutoApprove,
  })
  autonomyPostShip(ctx: PromptCtx): string {
    const mode = ctx.settings?.autoApproveMode ?? 'off';
    if (!modeApprovesShip(mode)) {
      return [
        "AUTONOMOUS MODE (plan gate only) — this job's plan-approval gate auto-advances, but the ship-review",
        'gate you are operating under is UNCHANGED: a finished build still waits for a human "Ship it" click',
        'before it ships. Proceed normally.',
      ].join('\n');
    }
    return [
      "AUTONOMOUS MODE — auto-approve is ON for this job's ship-review gate. A finished build ships WITHOUT a",
      '"Ship it" click the moment it reaches ship-review, and any amend you make re-arms and re-advances the',
      'same way. No operator will catch a mistake here — so verify HARDER before you amend, push, or open/',
      'update a PR: run the real live validation yourself, and only act on work you have actually exercised.',
      'Treat every gated action as the point of no return it now is.',
    ].join('\n');
  }
}
