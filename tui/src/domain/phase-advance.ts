import type { EPhaseKind, EThreadRole } from '../generated/prisma/enums.js';
import { EPhaseConfirm, phaseLabel, phaseSpecFor, rolesFor } from './phase-spec.js';
import { roleLabel } from './role-engine.js';

/**
 * Whether leaving this phase transitions without waiting on the human.
 *
 * Read off the phase being LEFT, because the question it answers — "was there a decision to make
 * here?" — is answered by the work that just finished, not by the work about to start.
 */
export function exitsWithoutAsking(kind: EPhaseKind): boolean {
  return phaseSpecFor(kind).confirm === EPhaseConfirm.auto;
}

/**
 * The exact inverse of `complete_thread`'s rule: you may only move the phase on if you are the last
 * thread still open in it. So the last thread's only legal moves are chart a successor
 * (`advance_thread`) or move the phase on — a phase can never empty itself by accident.
 *
 * Returns the refusal the agent reads, or `null` when the move is legal. A refusal rather than a
 * boolean because the agent has to be told what to do instead: a sibling is working, and waiting is
 * a real answer. No auto-close of the siblings — the human may be fanning out two threads
 * deliberately, and the harness must not silently kill one.
 */
export function notLastOpenThreadRefusal(args: {
  phase: EPhaseKind;
  callerThreadId: string;
  openThreadIds: readonly string[];
}): string | null {
  if (!args.openThreadIds.includes(args.callerThreadId)) {
    return 'this thread is already closed — it has no phase left to move on';
  }
  const others = args.openThreadIds.filter((id) => id !== args.callerThreadId);
  if (others.length === 0) return null;
  return [
    `${others.length} other thread${others.length === 1 ? ' is' : 's are'} still open in the`,
    `${phaseLabel(args.phase)} phase, so it is not finished. Finish your own work and hand over with`,
    'advance_thread, or wait for your sibling to close.',
  ].join(' ');
}

/**
 * The role a phase's first thread takes: the first of `PhaseSpec.roles`, which is written in menu
 * order and leads with the role the phase is actually for. `null` where a phase hosts none — no
 * phase does today, and a phase that forbade threads could not be entered at all.
 */
export function firstRoleFor(kind: EPhaseKind): EThreadRole | null {
  return rolesFor(kind)[0] ?? null;
}

/** What the proposing agent reads back when the phase it is leaving asks before it moves. */
export function proposalRaisedReply(args: {
  from: EPhaseKind;
  to: EPhaseKind;
  attachments: string;
}): string {
  return [
    `Raised: ${phaseLabel(args.from)} → ${phaseLabel(args.to)}. NOTHING has moved — Dennis sees this proposal and confirms or declines it, which may be hours from now.`,
    args.attachments,
    'End your turn here. You get no further turn in this thread whichever way he decides.',
  ].join(' · ');
}

/** And what it reads back where the phase it is leaving exits on its own — see `exitsWithoutAsking`. */
export function transitionedReply(args: {
  from: EPhaseKind;
  to: EPhaseKind;
  role: EThreadRole;
  attachments: string;
}): string {
  return [
    `Confirmed: ${phaseLabel(args.from)} → ${phaseLabel(args.to)} — this exit carries no decision, so it did not wait. This thread is closed and a ${roleLabel(args.role)} thread is open in ${phaseLabel(args.to)} with your hand-off.`,
    args.attachments,
    'Stop here — you have no further turn in this thread.',
  ].join(' · ');
}
