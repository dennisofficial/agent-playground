import { phaseLabel } from './phase-spec.js';
import { roleLabel } from './role-engine.js';
import { EThreadCondition } from '../generated/prisma/enums.js';
import type { EPhaseKind, EThreadRole } from '../generated/prisma/enums.js';

/**
 * Delegation with a report back, as pure rules: who may close, where the cursor lands when a thread
 * does, and the exact prose each side reads. The writes live in `app/thread-delegation.ts`; nothing
 * here touches a repository, which is what lets the cursor rule be table-tested.
 */

/**
 * The three conditions an agent may claim of itself — the enum on `complete_thread`, in menu order.
 *
 * The other three (`handed_off`, `phase_advanced`, `abandoned`) are Atlas's to stamp and are
 * unemittable, because no agent should be able to claim its work was carried on when it was not.
 * `out_of_scope` is 04 §1's finding made a value: a ticket that turns out to sit past the
 * destination is *closed, not resolved*, and collapsing the two loses the one line of the map that
 * says why the boundary is where it is.
 */
export const AGENT_CONDITIONS = [
  EThreadCondition.resolved,
  EThreadCondition.out_of_scope,
  EThreadCondition.blocked,
] as const;

const CONDITION_LABELS: Record<EThreadCondition, string> = {
  [EThreadCondition.resolved]: 'resolved',
  [EThreadCondition.out_of_scope]: 'out of scope',
  [EThreadCondition.blocked]: 'blocked',
  [EThreadCondition.handed_off]: 'handed off',
  [EThreadCondition.phase_advanced]: 'the phase advanced',
  [EThreadCondition.abandoned]: 'abandoned',
};

export function conditionLabel(condition: EThreadCondition): string {
  return CONDITION_LABELS[condition];
}

/**
 * The exact inverse of `advance_phase`'s rule: you may only close yourself while a sibling is still
 * open. Between them a phase can never empty itself by accident — the last thread's only legal moves
 * are chart a successor (`advance_thread`) or move the phase on (`advance_phase`).
 *
 * Returns the refusal the agent reads, or `null` when the move is legal, for the reason
 * `notLastOpenThreadRefusal` does: the agent has to be told what to do instead.
 */
export function lastOpenThreadRefusal(args: {
  phase: EPhaseKind;
  callerThreadId: string;
  openThreadIds: readonly string[];
}): string | null {
  if (!args.openThreadIds.includes(args.callerThreadId)) {
    return 'this thread is already closed — there is nothing left to complete';
  }
  if (args.openThreadIds.length > 1) return null;
  return [
    `you are the last open thread in the ${phaseLabel(args.phase)} phase, so closing here would`,
    'leave it with nobody in it. Hand your work to a successor with advance_thread, or move the job',
    'on with advance_phase — one of those two is what you actually mean.',
  ].join(' ');
}

/** One open thread as the cursor rule reads it. Structural, so `domain/` never sees a Prisma row. */
export type OpenThreadFact = {
  id: string;
  /** Who is waiting on it, where anyone is. */
  openedByThreadId: string | null;
  createdAt: Date;
};

export type CursorTarget = {
  threadId: string;
  /** The opener, waiting on this answer — the one case that also fires a turn. */
  viaOpener: boolean;
};

/**
 * Where the cursor goes when a thread closes: the **opener** if it set one and it is still open,
 * else a thread THIS one opened and never came back to, else the phase's oldest remaining open
 * thread.
 *
 * The middle clause is design 03 §13's *"next `pending` sibling"* as the schema can express it
 * today: `EThreadStatus` has no `pending`, since threads are seeded the moment they open, so the
 * nearest real thing is a delegate whose opener is the thread now closing — it is about to have
 * nobody waiting on it, and it is exactly the row a human would look for next.
 *
 * `null` only where nothing else is open, which `lastOpenThreadRefusal` already forbids for
 * `complete_thread`. It is still a case rather than a throw because the harness closes threads too,
 * and a cursor left pointing at a closed thread is worse than a cursor that did not move.
 */
export function cursorAfterClose(args: {
  closing: { id: string; openedByThreadId: string | null };
  /** Every open thread in the phase as it stood BEFORE the close, the closer included. */
  openThreads: readonly OpenThreadFact[];
}): CursorTarget | null {
  const siblings = [...args.openThreads]
    .filter((thread) => thread.id !== args.closing.id)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const opener = siblings.find(
    (thread) => thread.id === args.closing.openedByThreadId,
  );
  if (opener) return { threadId: opener.id, viaOpener: true };

  const delegate = siblings.find(
    (thread) => thread.openedByThreadId === args.closing.id,
  );
  if (delegate) return { threadId: delegate.id, viaOpener: false };

  const next = siblings[0];
  return next ? { threadId: next.id, viaOpener: false } : null;
}

/**
 * What lands in the OPENER when its delegate closes — a harness message, and the prompt of the turn
 * that fires on it. Attributed and framed, for `successorSeed`'s reason: the reader has to be able
 * to weigh it, and a bare paragraph appearing in its transcript would read as if Dennis typed it.
 */
export function resolutionReport(args: {
  fromRole: EThreadRole;
  condition: EThreadCondition;
  resolution: string;
}): string {
  return [
    `# Report from the ${roleLabel(args.fromRole)} thread you opened`,
    '',
    `It closed as **${conditionLabel(args.condition)}**. This is everything it chose to report`,
    'back; its transcript is still readable with `atlas transcript`, and nothing else came with it.',
    '',
    args.resolution.trim(),
    '',
    'You were waiting on this. Pick up where you left off.',
  ].join('\n');
}

/**
 * What the DELEGATING agent reads back. It gets no answer here on purpose — the close carries the
 * response, and a synchronous return would hold this query open for however long that conversation
 * takes — so the reply's whole job is to stop it waiting for one.
 */
export function delegatedReply(args: {
  role: EThreadRole;
  attachments: string;
}): string {
  return [
    `A ${roleLabel(args.role)} thread is open with your brief and is now the job's active thread. This thread stays open.`,
    args.attachments,
    'You get NO answer here: when that thread closes, its report arrives as a message in this thread and a turn fires on it. End your turn now.',
  ].join(' · ');
}

/** And what the CLOSING agent reads back, including where it just sent the human. */
export function completedReply(args: {
  condition: EThreadCondition;
  /** Where the cursor landed. Null where the close left the phase with nothing addressable. */
  cursor: { role: EThreadRole; viaOpener: boolean } | null;
}): string {
  const landed = args.cursor
    ? args.cursor.viaOpener
      ? `Your report was delivered to the ${roleLabel(args.cursor.role)} thread that opened you, which is now the job's active thread and is picking it up.`
      : `The ${roleLabel(args.cursor.role)} thread is now the job's active thread.`
    : 'Nothing else is open in this phase.';
  return [
    `This thread is closed as ${conditionLabel(args.condition)}.`,
    landed,
    'Stop here — you have no further turn in this thread.',
  ].join(' · ');
}
