import { type AutoApproveMode, modeApprovesPlan, modeApprovesShip } from '@workspace/shared';

export function composeMode(plan: boolean, ship: boolean): AutoApproveMode {
  if (plan && ship) return 'both';
  if (plan) return 'plan';
  if (ship) return 'ship';
  return 'off';
}

export type AutoPillTone = 'off' | 'partial' | 'full';

/** How the header pill reads a mode: quiet grey (off), amber naming the single active gate (partial), or
 *  solid green "Auto" (both gates armed). */
export function autoPillView(mode: AutoApproveMode): {
  tone: AutoPillTone;
  label: string;
} {
  const plan = modeApprovesPlan(mode);
  const ship = modeApprovesShip(mode);
  if (plan && ship) return { tone: 'full', label: 'Auto' };
  if (plan) return { tone: 'partial', label: 'Plan' };
  if (ship) return { tone: 'partial', label: 'Ship' };
  return { tone: 'off', label: 'Auto' };
}
