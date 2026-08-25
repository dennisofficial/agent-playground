import { EPhaseKind, EThreadRole } from '../generated/prisma/enums.js';
import { humanRolesFor, nextPhasesFor, phaseLabel, rolesFor } from './phase-spec.js';
import { roleLabel } from './role-engine.js';

/**
 * The three moves Dennis makes himself, as menus.
 *
 * Every other way a phase or a thread comes into being is agent-initiated — `advance_phase`,
 * `open_thread` and `advance_thread` are tools, called from inside a turn. So **a job with nothing
 * open is structurally a job nobody can re-enter**: there is no one home to propose. These are what
 * close that hole, and they are pure menu shaping precisely so the rule that governs them can be
 * asserted without a terminal.
 *
 * The rule: **the phase graph rails the AGENT, never the human.** `PhaseSpec.next` is the enum on
 * `advance_phase` and means *what may be proposed from here*. It is not a whitelist of what is
 * legal — `ci.next` is empty, so a menu built from `next` would strand a red build with no move at
 * all. Every phase is offered; `next` only decides the ORDER.
 */

/** One entry of the start-a-phase menu. */
export type PhaseChoice = {
  kind: EPhaseKind;
  label: string;
  /**
   * The phase being left would propose this one on its own. A hint about what usually comes next,
   * never a gate — the entries below it are exactly as legal, and pressing one is not an override.
   */
  suggested: boolean;
};

/** One entry of the open-a-thread menu. */
export type RoleChoice = {
  role: EThreadRole;
  label: string;
  /**
   * Shown beside the label where a role needs a word of explanation. Only the human-only ones do:
   * every other entry is named after the phase you are standing in and reads for itself, while
   * `generic` in a `build` phase is the one row whose presence is not self-evident.
   */
  hint?: string;
};

/**
 * Every phase, with the current one's `next` first.
 *
 * All of `EPhaseKind`, deliberately — including the phase you are standing in, because `ci → ci` is
 * a legal move (a second ship after a fix) and a menu that hid it would be asserting a rule the
 * graph does not have. The tail keeps the enum's own declaration order, which is pipeline order, so
 * the list past the suggestions still reads as the route rather than as an alphabet.
 */
export function startablePhases(current: EPhaseKind): readonly PhaseChoice[] {
  const suggested = nextPhasesFor(current);
  const rest = Object.values(EPhaseKind).filter(
    (kind) => !suggested.includes(kind),
  );
  return [...suggested, ...rest].map((kind) => ({
    kind,
    label: phaseLabel(kind),
    suggested: suggested.includes(kind),
  }));
}

/**
 * The roles a thread may be opened with here: `PhaseSpec.roles` plus the human-only ones the phase
 * did not list. There is still no second role TABLE — `humanRolesFor` reads the same phase spec the
 * agent's `open_thread` enum is built from, and the two differ only by which side of
 * `HUMAN_ONLY_ROLES` a role falls on.
 *
 * The asymmetry is the point. `generic` is offered in every phase and to nobody but Dennis, so a
 * question that is not this job's work has somewhere honest to go; every other role is exactly the
 * phase's own list, so a phase that hosts nothing still forbids threads by construction. No flag.
 */
export function openableRoles(phase: EPhaseKind): readonly RoleChoice[] {
  return humanRolesFor(phase).map((role) => ({
    role,
    label: roleLabel(role),
    // Only where the phase did not ask for it — in the `generic` phase this row IS the phase, and
    // captioning it there would explain the obvious.
    ...(role === EThreadRole.generic && !rolesFor(phase).includes(role)
      ? { hint: 'yours — opens blank, no brief' }
      : {}),
  }));
}

/**
 * The heading over the start-a-phase menu. It names where you are because the menu offers
 * everything: without the current phase on screen, "planning" reads as a statement of fact rather
 * than as a choice you are about to make.
 */
export function startPhaseTitle(current: EPhaseKind): string {
  return `start a phase · now in ${phaseLabel(current)}`;
}

/**
 * And over the open-a-thread menu. **Current phase only**: phases are append-only and are never
 * reopened, so reaching into a past one is a new phase, not a reopen — which is what the other verb
 * is for.
 */
export function openThreadTitle(current: EPhaseKind): string {
  return `open a thread in ${phaseLabel(current)}`;
}

/** What closing a thread by hand asks, and what it costs. */
export function closeThreadQuestion(role: EThreadRole): string {
  return `close the ${roleLabel(role)} thread?`;
}

/**
 * Said under the question. A phase with nothing in it is a legal, expected state — it is exactly
 * what a shipped job is — so this explains rather than warns, and adds the one real cost (a running
 * turn is interrupted) only when there is one.
 */
export function closeThreadDetail(args: {
  /** Whether this is the last thread still open in the phase. */
  last: boolean;
  running: boolean;
}): string {
  const parts = [
    'recorded as abandoned',
    args.last
      ? 'nothing else is open in this phase, which is fine — start a phase or open a thread when you come back'
      : 'the cursor moves to what is still open',
  ];
  if (args.running) parts.unshift('an agent is working in it and will be interrupted');
  return parts.join(' · ');
}
