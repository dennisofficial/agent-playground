import { describe, expect, it } from 'bun:test';
import {
  closeThreadDetail,
  closeThreadQuestion,
  openableRoles,
  openThreadTitle,
  startPhaseTitle,
  startablePhases,
} from '../human-verbs.js';
import { nextPhasesFor, PHASE_SPECS, rolesFor } from '../phase-spec.js';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';

const EVERY_PHASE = Object.values(EPhaseKind);

describe('startablePhases', () => {
  // The whole point of the verb. `next` is the enum on the AGENT's advance tool; the human was
  // never railed by it, and a menu built from `next` would strand `ci` — whose `next` is empty —
  // with no legal move at all, which is exactly the hole this ticket exists to close.
  it.each(EVERY_PHASE)('offers every phase from %s', (current) => {
    const offered = startablePhases(current).map((choice) => choice.kind);
    expect([...offered].sort()).toEqual([...EVERY_PHASE].sort());
  });

  it('leads with what this phase would propose, in the graph’s own order', () => {
    const choices = startablePhases(EPhaseKind.planning);
    const suggested = nextPhasesFor(EPhaseKind.planning);
    expect(choices.slice(0, suggested.length).map((c) => c.kind)).toEqual([
      ...suggested,
    ]);
    expect(choices.slice(0, suggested.length).every((c) => c.suggested)).toBe(true);
    expect(choices.slice(suggested.length).some((c) => c.suggested)).toBe(false);
  });

  // A red build: `ci` proposes nothing, so every entry is an ordinary one and the menu is the only
  // way back into the job.
  it('offers ci a full menu with nothing suggested', () => {
    const choices = startablePhases(EPhaseKind.ci);
    expect(nextPhasesFor(EPhaseKind.ci)).toEqual([]);
    expect(choices).toHaveLength(EVERY_PHASE.length);
    expect(choices.some((choice) => choice.suggested)).toBe(false);
    // `ci → ci` is a legal second ship, so the phase you are standing in is in its own menu.
    expect(choices.map((c) => c.kind)).toContain(EPhaseKind.ci);
  });

  it('never offers the same phase twice', () => {
    for (const current of EVERY_PHASE) {
      const offered = startablePhases(current).map((c) => c.kind);
      expect(new Set(offered).size).toBe(offered.length);
    }
  });

  it('spells a phase without its underscores', () => {
    const direct = startablePhases(EPhaseKind.planning).find(
      (choice) => choice.kind === EPhaseKind.direct_build,
    );
    expect(direct?.label).toBe('direct build');
  });
});

describe('openableRoles', () => {
  // There is exactly one role list in this app: the same `PhaseSpec.roles` the agent's `open_thread`
  // enum is built from. A parallel list is the thing this asserts can never appear.
  it.each(EVERY_PHASE)('offers %s exactly the phase table’s roles', (phase) => {
    expect(openableRoles(phase).map((choice) => choice.role)).toEqual([
      ...rolesFor(phase),
    ]);
  });

  // No `allowHumanThreads` dial anywhere: a phase forbids human threads by declaring none, and the
  // menu is empty by construction. No phase does today, and this is what would say so if one did.
  it('forbids by construction rather than by flag', () => {
    for (const spec of Object.values(PHASE_SPECS)) {
      expect(openableRoles(spec.kind).length).toBe(spec.roles.length);
    }
  });

  it('labels a role the way every other surface does', () => {
    expect(openableRoles(EPhaseKind.ci).map((choice) => choice.label)).toEqual([
      'ship pr',
      'ci',
    ]);
  });
});

describe('the prose', () => {
  it('names where you are, because the menu offers everywhere', () => {
    expect(startPhaseTitle(EPhaseKind.post_build)).toContain('post build');
    expect(openThreadTitle(EPhaseKind.direct_build)).toContain('direct build');
  });

  it('asks by role', () => {
    expect(closeThreadQuestion(EThreadRole.ship_pr)).toBe('close the ship pr thread?');
  });

  // A phase with nothing running is expected, not an error — so the last-thread case explains
  // rather than warns. The interrupt is the one real cost, and it is only mentioned when true.
  it('explains the empty phase and warns only about a live turn', () => {
    const last = closeThreadDetail({ last: true, running: false });
    expect(last).toContain('abandoned');
    expect(last).toContain('which is fine');
    expect(last).not.toContain('interrupted');
    expect(closeThreadDetail({ last: false, running: true })).toContain('interrupted');
  });
});
