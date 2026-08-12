import { describe, expect, it } from 'bun:test';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import {
  exitsWithoutAsking,
  firstRoleFor,
  notLastOpenThreadRefusal,
  proposalRaisedReply,
  transitionedReply,
} from '../phase-advance.js';

describe('who waits on the human', () => {
  it('asks on the boundaries with a fork or an artifact to eyeball', () => {
    // Planning hands over spec files Dennis reviews, and picks between two kinds of build; charting
    // picks between planning and design. Both are decisions, so both stop.
    expect(exitsWithoutAsking(EPhaseKind.planning)).toBe(false);
    expect(exitsWithoutAsking(EPhaseKind.charting)).toBe(false);
    expect(exitsWithoutAsking(EPhaseKind.generic)).toBe(false);
    expect(exitsWithoutAsking(EPhaseKind.post_build)).toBe(false);
  });

  it('does not ask where the exit carries no decision', () => {
    // A keystroke here would carry no information, and an ask that carries none is the one that
    // trains `y` as a reflex — which is how the plan gets approved unread.
    expect(exitsWithoutAsking(EPhaseKind.build)).toBe(true);
    expect(exitsWithoutAsking(EPhaseKind.direct_build)).toBe(true);
    expect(exitsWithoutAsking(EPhaseKind.master_review)).toBe(true);
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

  it('says the opposite where the exit did not wait — the agent must not be told a lie it gets no turn to correct', () => {
    const reply = transitionedReply({
      from: EPhaseKind.direct_build,
      to: EPhaseKind.post_build,
      role: EThreadRole.post_build,
      attachments: 'no files attached',
    });

    expect(reply).toContain('Confirmed');
    expect(reply).toContain('This thread is closed');
    expect(reply).not.toContain('NOTHING has moved');
  });
});
