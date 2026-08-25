import type { EPhaseKind } from '../generated/prisma/enums.js';
import { phaseLabel, type ContextFileRef } from './phase-spec.js';

/**
 * What the confirm overlay draws, decided without a terminal.
 *
 * The overlay is **yes/no** and carries no destination picker (design 22 §5): an editable target
 * makes the row ambiguous about what was PROPOSED versus what was chosen, and declines are the data
 * that later says a trigger is mistuned. Decline and say why, or start a phase by hand — which
 * reaches any phase and writes its own row.
 */

/** The proposal as a reader meets it: where it goes, why, and what crosses with it. */
export type ProposalView = {
  /** `planning → build`, or just the destination for a job's first phase. */
  route: string;
  /** The agent's prose, written FOR Dennis. The headline, and the only thing he must read. */
  reason: string;
  /** The four-section hand-off the successor opens with. Empty where the row carried none. */
  handoff: string;
  /** Every file crossing the boundary, in the order the seam will inline it. */
  files: readonly string[];
};

/**
 * The row plus the phase it is leaving, as lines. `from` is nullable because a job's first phase
 * has nothing behind it, and an arrow pointing at nothing reads worse than no arrow at all.
 */
export function proposalView(args: {
  transition: { to: EPhaseKind; reason: string; handoff: string | null };
  from: EPhaseKind | null;
  attached: readonly ContextFileRef[];
}): ProposalView {
  const { transition } = args;
  return {
    route: args.from
      ? `${phaseLabel(args.from)} → ${phaseLabel(transition.to)}`
      : phaseLabel(transition.to),
    reason: transition.reason,
    handoff: transition.handoff ?? '',
    files: args.attached.map(attachedLabel),
  };
}

/** The same name the chip and the inlined fence use — see `attachmentLabel`. */
function attachedLabel(ref: ContextFileRef): string {
  return `context/${ref.bucket}/${ref.path}`;
}

/**
 * Whether the overlay opens as a REVIEW — the documents showing — rather than as a menu.
 *
 * Design 02 §3: plan approval and the ship button are the same operation, differing only in whether
 * the proposal carries artifacts. A `specs/` file crossing the boundary IS the plan, and confirming
 * without it on screen is the `y`-as-reflex failure the confirm rule exists to avoid. Read off the
 * material rather than off the destination phase, so a boundary that grows specs needs no edit here.
 */
export function opensAsReview(attached: readonly ContextFileRef[]): boolean {
  return attached.some((ref) => ref.bucket === 'specs');
}

/**
 * Whether the proposal owns the keyboard.
 *
 * Three separate answers, and the order is the argument. A proposal Dennis asked to see wins over
 * everything; one he pushed away stays away until the next one; and otherwise it opens ITSELF —
 * unless he is mid-sentence. That last clause is the whole safety story: every `useKeyboard`
 * listener fires for every key, so an overlay that took `y` out from under a half-typed steer would
 * confirm a phase advance the moment he typed the word "yes".
 */
export function opensProposal(args: {
  /** The oldest pending proposal for this job, or null when nothing is waiting. */
  pendingId: string | null;
  /** Asked for by hand — `ctrl+y`, which is how a deferred proposal comes back. */
  requestedId: string | null;
  /** Pushed away with `esc`. The row stays pending; the lists keep saying `confirm`. */
  deferredId: string | null;
  draftLength: number;
}): boolean {
  if (args.pendingId === null) return false;
  if (args.pendingId === args.requestedId) return true;
  if (args.pendingId === args.deferredId) return false;
  return args.draftLength === 0;
}

/** The keys the overlay claims, longest-first — `fitHints` picks the widest that fits. */
export function proposalKeyHints(args: {
  expanded: boolean;
  hasDocuments: boolean;
}): readonly string[] {
  const documents = args.hasDocuments
    ? [`x ${args.expanded ? 'hide' : 'read'} the hand-off`]
    : [];
  return [
    ['y confirm', 'n decline', ...documents, 'esc decide later'].join(' · '),
    ['y confirm', 'n decline', 'esc later'].join(' · '),
    'y · n',
  ];
}

/** Collapsed, the review says how much there is to read rather than showing none of it. */
export function reviewSummary(args: {
  handoff: string;
  files: readonly string[];
}): string {
  const lines = args.handoff.length === 0 ? 0 : args.handoff.split('\n').length;
  const parts: string[] = [];
  if (lines > 0) parts.push(`hand-off ${lines} line${lines === 1 ? '' : 's'}`);
  if (args.files.length > 0) {
    parts.push(`${args.files.length} file${args.files.length === 1 ? '' : 's'}`);
  }
  return parts.length === 0 ? 'nothing carried' : parts.join(' · ');
}

/**
 * What Dennis is told after `n`.
 *
 * Declining writes the row and does NOTHING else, deliberately (design 02 §7): the proposing thread
 * stays open and its composer is right there, so saying why is a conversation rather than a
 * mechanism. This line is the nudge that makes that obvious instead of leaving `n` looking inert.
 */
export const DECLINED_NOTICE =
  'declined — this thread is still open · tell it why in the composer';
