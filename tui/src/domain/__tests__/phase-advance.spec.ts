import { describe, expect, it } from 'bun:test';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import {
  firstRoleFor,
  notLastOpenThreadRefusal,
  proposalRaisedReply,
} from '../phase-advance.js';
import { PHASE_SPECS } from '../phase-spec.js';

describe('who waits on the human', () => {
  it('waits on EVERY phase — there is no automatic exit and no setting for one', () => {
    // Confirmation is not a property of the phase being left. An earlier cut made it one and let
    // `build`, `direct_build` and `master_review` transition unattended, which meant `build →
    // planning` — the plan turning out to be WRONG, the clearest fork in the graph — moved with no
    // keypress, indistinguishable from `build → master_review` because both leave `build`.
    //
    // Asserted against the spec objects themselves so that reintroducing any per-phase confirm
    // field fails here rather than quietly re-enabling the branch.
    for (const spec of Object.values(PHASE_SPECS)) {
      expect(spec).not.toHaveProperty('confirm');
    }
  });
});

describe('the last open thread', () => {
  it('lets the last one through', () => {
    expect(
      notLastOpenThreadRefusal({
        phase: EPhaseKind.charting,
        callerThreadId: 'thread-1',
        openThreadIds: ['thread-1'],
      }),
    ).toBeNull();
  });

  it('refuses while a sibling is still working, and says what to do instead', () => {
    const refusal = notLastOpenThreadRefusal({
      phase: EPhaseKind.charting,
      callerThreadId: 'thread-1',
      openThreadIds: ['thread-1', 'thread-2'],
    });

    expect(refusal).toContain('still open');
    // No auto-close of the sibling: two charting threads may be a deliberate fan-out, and the
    // harness must not silently kill one to satisfy an advance.
    expect(refusal).toContain('advance_thread');
  });

  it('refuses a caller that is not open at all', () => {
    expect(
      notLastOpenThreadRefusal({
        phase: EPhaseKind.build,
        callerThreadId: 'thread-9',
        openThreadIds: ['thread-1'],
      }),
    ).toContain('closed');
  });
});

describe('what the next phase opens with', () => {
  it('takes the first role of the phase it is entering — the one the phase is for', () => {
    expect(firstRoleFor(EPhaseKind.build)).toBe(EThreadRole.builder);
    expect(firstRoleFor(EPhaseKind.planning)).toBe(EThreadRole.planner);
    // `ci` hosts two roles and opens with the shipping one; the `ci` role is what a human opens by
    // hand when a build comes back red, and is second in the list precisely because of this rule.
    expect(firstRoleFor(EPhaseKind.ci)).toBe(EThreadRole.ship_pr);
  });
});

describe('what the proposing agent reads back', () => {
  it('says nothing moved, and to stop', () => {
    const reply = proposalRaisedReply({
      from: EPhaseKind.planning,
      to: EPhaseKind.build,
      attachments: 'attached context/specs/plan.md',
    });

    expect(reply).toContain('NOTHING has moved');
    expect(reply).toContain('End your turn here');
    expect(reply).toContain('context/specs/plan.md');
  });

});
