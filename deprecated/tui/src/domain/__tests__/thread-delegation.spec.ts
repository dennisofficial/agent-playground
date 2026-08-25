import { describe, expect, it } from 'bun:test';
import {
  AGENT_CONDITIONS,
  completedReply,
  cursorAfterClose,
  lastOpenThreadRefusal,
  resolutionReport,
  type OpenThreadFact,
} from '../thread-delegation.js';
import { EPhaseKind, EThreadCondition, EThreadRole } from '../../generated/prisma/enums.js';

/**
 * The two rules a phase's shape depends on: who may close, and where the human goes when someone
 * does. Both are pure, which is the whole reason they are testable without a database — the writes
 * that follow them are a repository call each.
 */

function thread(args: {
  id: string;
  openedBy?: string;
  minute?: number;
}): OpenThreadFact {
  return {
    id: args.id,
    openedByThreadId: args.openedBy ?? null,
    createdAt: new Date(2026, 0, 1, 12, args.minute ?? 0),
  };
}

describe('lastOpenThreadRefusal', () => {
  it('refuses the last open thread — a phase can never empty itself by accident', () => {
    const refusal = lastOpenThreadRefusal({
      phase: EPhaseKind.planning,
      callerThreadId: 'thread-1',
      openThreadIds: ['thread-1'],
    });

    expect(refusal).toContain('last open thread');
    // Told what to do INSTEAD: a refusal that only says no costs a turn and teaches nothing.
    expect(refusal).toContain('advance_thread');
    expect(refusal).toContain('advance_phase');
  });

  it('allows a close while a sibling is still open', () => {
    expect(
      lastOpenThreadRefusal({
        phase: EPhaseKind.planning,
        callerThreadId: 'thread-1',
        openThreadIds: ['thread-1', 'thread-2'],
      }),
    ).toBeNull();
  });

  it('refuses a thread that is already closed rather than closing it twice', () => {
    expect(
      lastOpenThreadRefusal({
        phase: EPhaseKind.planning,
        callerThreadId: 'thread-9',
        openThreadIds: ['thread-1', 'thread-2'],
      }),
    ).toContain('already closed');
  });

  it('is the exact inverse of advance_phase: exactly one of the two doors is open, always', () => {
    // The pairing is the invariant, not either rule on its own — with both closed a phase strands,
    // and with both open a thread can empty a phase and move it on in the same breath.
    for (const open of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
      const mayComplete =
        lastOpenThreadRefusal({
          phase: EPhaseKind.build,
          callerThreadId: 'a',
          openThreadIds: open,
        }) === null;
      const mayAdvancePhase = open.length === 1;
      expect(mayComplete).toBe(!mayAdvancePhase);
    }
  });
});

describe('cursorAfterClose', () => {
  it('returns to the OPENER, which is the one case that also fires a turn', () => {
    const target = cursorAfterClose({
      closing: { id: 'delegate', openedByThreadId: 'planner' },
      openThreads: [
        thread({ id: 'planner', minute: 0 }),
        thread({ id: 'other', minute: 1 }),
        thread({ id: 'delegate', openedBy: 'planner', minute: 2 }),
      ],
    });

    expect(target).toEqual({ threadId: 'planner', viaOpener: true });
  });

  it('falls through to a sibling when the opener has itself closed', () => {
    const target = cursorAfterClose({
      closing: { id: 'delegate', openedByThreadId: 'gone' },
      openThreads: [
        thread({ id: 'sibling', minute: 1 }),
        thread({ id: 'delegate', openedBy: 'gone', minute: 2 }),
      ],
    });

    // Not `viaOpener`: there is nobody waiting, so nothing is reported and no turn fires.
    expect(target).toEqual({ threadId: 'sibling', viaOpener: false });
  });

  it('prefers a thread THIS one opened over an unrelated sibling', () => {
    const target = cursorAfterClose({
      closing: { id: 'planner', openedByThreadId: null },
      openThreads: [
        thread({ id: 'unrelated', minute: 0 }),
        thread({ id: 'planner', minute: 1 }),
        thread({ id: 'delegate', openedBy: 'planner', minute: 2 }),
      ],
    });

    // Its opener is about to be gone, so it is the row with nobody holding it — design 03 §13's
    // "next pending sibling" as a schema without a `pending` status can express it.
    expect(target?.threadId).toBe('delegate');
    expect(target?.viaOpener).toBe(false);
  });

  it('otherwise takes the phase’s oldest remaining open thread', () => {
    const target = cursorAfterClose({
      closing: { id: 'closing', openedByThreadId: null },
      openThreads: [
        thread({ id: 'closing', minute: 0 }),
        thread({ id: 'newer', minute: 5 }),
        thread({ id: 'older', minute: 1 }),
      ],
    });

    expect(target?.threadId).toBe('older');
  });

  it('never points at the thread that is closing, and never at nothing', () => {
    expect(
      cursorAfterClose({
        closing: { id: 'only', openedByThreadId: null },
        openThreads: [thread({ id: 'only' })],
      }),
    ).toBeNull();
  });
});

describe('what each side reads', () => {
  it('attributes the report and names the condition, so the opener can weigh it', () => {
    const report = resolutionReport({
      fromRole: EThreadRole.charting,
      condition: EThreadCondition.out_of_scope,
      resolution: 'The retry policy belongs to the queue, not to this job.',
    });

    expect(report).toContain('charting');
    expect(report).toContain('out of scope');
    expect(report).toContain('The retry policy belongs to the queue');
  });

  it('tells the closing agent where the human went and that it is done', () => {
    const reply = completedReply({
      condition: EThreadCondition.resolved,
      cursor: { role: EThreadRole.planner, viaOpener: true },
    });

    expect(reply).toContain('resolved');
    expect(reply).toContain('planner');
    expect(reply).toContain('no further turn');
  });

  it('offers the agent only the conditions it may claim of itself', () => {
    // The other three are Atlas's to stamp: an agent must not be able to say its work was handed on.
    expect([...AGENT_CONDITIONS]).toEqual([
      EThreadCondition.resolved,
      EThreadCondition.out_of_scope,
      EThreadCondition.blocked,
    ]);
  });
});
