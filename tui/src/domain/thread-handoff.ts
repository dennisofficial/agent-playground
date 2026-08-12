import { roleLabel } from './role-engine.js';
import type { AttachmentPart } from './attachments.js';
import type { EThreadRole } from '../generated/prisma/enums.js';

/**
 * Why the thread reading this exists — and the one thing the writer's own words cannot say, because
 * the writer does not know whether it is about to close.
 *
 * It changes exactly one paragraph and it is not decoration: a succession's author is gone and a
 * delegation's author is sitting there waiting for an answer, so a delegate told "that thread is
 * closed" would report back to nobody and a successor told "it is waiting on you" would wait for a
 * reply that can never come.
 */
export enum EHandoffKind {
  succession = 'succession',
  delegation = 'delegation',
  /**
   * A rotation: the SAME thread, one session later. Neither of the other two framings is true here
   * — nothing closed and nobody is waiting — and a rotating agent told "that thread is closed" would
   * believe its own work had been taken off it.
   */
  rotation = 'rotation',
}

/**
 * What a successor is told, over and above the phase's own opening words. The same shape whether it
 * succeeds a thread or a whole phase — a hand-off is prose, its author, and the material it named.
 */
export type SeedHandoff = {
  text: string;
  fromRole: EThreadRole;
  /** Already rendered by `gatherAttachments` — floor plus declaration, inlined in full. */
  attachments: string;
  /**
   * The same attachments as ROWS, and the one the seam prefers when it is there: the message stores
   * the manifest and composes the wire form at send, which is what lets the transcript draw a file
   * chip without parsing the composed body back apart. Optional so a caller that has not been given
   * a manifest still hands over the inlined prose — same bytes to the model, no chips on screen.
   */
  parts?: readonly AttachmentPart[];
  /**
   * Optional, defaulting to `succession`, because succession is the shape that predates delegation
   * and every caller that does not say otherwise means it — a required field here would only have
   * made three existing call sites repeat the word.
   */
  kind?: EHandoffKind;
};

/**
 * The first thing a successor thread ever reads.
 *
 * Three parts in one message rather than three messages, because they are one act: a thread that
 * exists because another thread finished has to be told where it is, what happened, and what it was
 * handed — and splitting that across turns would let it start work having read only the first part.
 *
 * General before specific, the same order `buildSystemPrompt` uses: the phase's opening orients, the
 * hand-off is the reason this particular thread exists, and the attachments are the material. Read
 * the other way round, the hand-off is prose about a situation the reader has not been placed in yet.
 */
export function successorSeed(args: {
  /** The phase's situational opening — what any thread entering this phase is told. */
  opening: string;
  /** The outgoing agent's own words. Never summarised or rewritten by Atlas. */
  handoff: string;
  /** Who wrote it, so the successor can weigh it — a planner's hand-off is not a builder's. */
  fromRole: EThreadRole;
  /** Already rendered by `renderAttachments`; empty when nothing was attached and the floor is bare. */
  attachments: string;
  kind?: EHandoffKind;
}): string {
  const sections = [
    args.opening.trim(),
    [
      ...seedHeading({ kind: args.kind, fromRole: args.fromRole }),
      '',
      args.handoff.trim(),
    ].join('\n'),
    args.attachments.trim(),
  ];
  return sections.filter((section) => section.length > 0).join('\n\n');
}

/** Succession is the default because it is the seam that predates the other two. */
function seedHeading(args: {
  kind?: EHandoffKind;
  fromRole: EThreadRole;
}): string[] {
  if (args.kind === EHandoffKind.delegation) return delegationHeading(args.fromRole);
  if (args.kind === EHandoffKind.rotation) return rotationHeading();
  return successionHeading(args.fromRole);
}

function successionHeading(fromRole: EThreadRole): string[] {
  return [
    `# Hand-off from the ${roleLabel(fromRole)} thread before you`,
    '',
    'That thread is closed. This is everything it chose to carry forward — its transcript is',
    'still readable with `atlas transcript`, but nothing else came with you.',
  ];
}

/**
 * The rotating agent's framing, and the only one that does not name a role — because the role is its
 * own. It says plainly that nothing has been taken away: the thread, the work, the files and the
 * job's cursor are all where they were, and the transcript it is being told about is one it wrote.
 * A leg that believes it has inherited someone else's job re-litigates decisions it made itself.
 */
function rotationHeading(): string[] {
  return [
    '# Hand-off from your own previous session',
    '',
    'Same thread, same work, new context window — you wrote this at the end of the leg before this',
    'one. That leg’s transcript is still readable with `atlas transcript`, but nothing else came',
    'with you, so this and the files below are what you have.',
  ];
}

/**
 * The delegate's framing. It names the report-back mechanism explicitly because that mechanism is
 * the whole point of the thread existing: this agent was opened to answer something, and it must
 * know that `complete_thread`'s `resolution` — not its last assistant message — is what the waiting
 * thread will actually read.
 */
function delegationHeading(fromRole: EThreadRole): string[] {
  return [
    `# Brief from the ${roleLabel(fromRole)} thread that opened you`,
    '',
    'That thread is STILL OPEN and waiting on you. It did not watch you work and its transcript is',
    'not yours: what it will read is the `resolution` you pass to `complete_thread`, delivered as a',
    'message that fires its next turn. Write that for it, and nothing else comes back with you.',
  ];
}
