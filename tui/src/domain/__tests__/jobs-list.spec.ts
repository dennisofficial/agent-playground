import { describe, expect, it } from 'bun:test';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import { deletionCost, formatWhen, jobSummary, jobsLayout } from '../jobs-list.js';

describe('jobsLayout', () => {
  it('gives the status its widest form when the terminal can afford it', () => {
    expect(jobsLayout(120).status).toBe(20);
  });

  it('steps the status down before it starves the title', () => {
    const wide = jobsLayout(120);
    const narrow = jobsLayout(48);
    expect(narrow.status).toBeLessThan(wide.status);
    expect(narrow.title).toBeGreaterThanOrEqual(16);
  });

  it('drops the status entirely rather than leave the title unreadable', () => {
    expect(jobsLayout(34).status).toBe(0);
  });

  it('never returns a negative title, however small the terminal gets', () => {
    for (const width of [0, 1, 10, 20]) {
      expect(jobsLayout(width).title).toBeGreaterThanOrEqual(3);
    }
  });

  it('caps the title so a wide terminal does not stretch one column across the screen', () => {
    expect(jobsLayout(400).title).toBe(56);
  });
});

describe('jobSummary', () => {
  it('reads the phase and role of the active thread', () => {
    expect(
      jobSummary({
        activePhase: EPhaseKind.build,
        activeRole: EThreadRole.builder,
      }),
    ).toBe('build · builder');
  });

  it('spells a role without its underscores', () => {
    expect(
      jobSummary({
        activePhase: EPhaseKind.planning,
        activeRole: EThreadRole.plan_review,
      }),
    ).toBe('planning · plan review');
  });

  it('says active when nothing is open, rather than drawing a half-empty pair', () => {
    expect(
      jobSummary({ activePhase: EPhaseKind.build, activeRole: null }),
    ).toBe('active');
  });
});

describe('deletionCost', () => {
  it('counts the transcript the confirm is about to burn', () => {
    expect(deletionCost({ messageCount: 12 })).toStartWith('12 messages');
  });

  it('does not pluralise a single message', () => {
    expect(deletionCost({ messageCount: 1 })).toStartWith('1 message ·');
  });

  it('says so plainly when there is nothing to lose', () => {
    expect(deletionCost({ messageCount: 0 })).toStartWith('nothing said yet');
  });
});

describe('formatWhen', () => {
  const now = new Date('2026-08-11T15:00:00');

  it('shows a zero-padded clock for today', () => {
    expect(formatWhen({ date: new Date('2026-08-11T09:05:00'), now })).toBe('09:05');
  });

  it('shows a weekday inside the last week', () => {
    const when = formatWhen({ date: new Date('2026-08-08T09:00:00'), now });
    expect(when).toBe(new Date('2026-08-08T09:00:00').toLocaleDateString(undefined, {
      weekday: 'short',
    }));
  });

  it('shows a date once it is older than a week', () => {
    const when = formatWhen({ date: new Date('2026-07-01T09:00:00'), now });
    expect(when).toBe(
      new Date('2026-07-01T09:00:00').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      }),
    );
  });

  it('treats yesterday as a weekday even minutes after midnight', () => {
    const justAfterMidnight = new Date('2026-08-11T00:10:00');
    expect(formatWhen({ date: new Date('2026-08-10T23:50:00'), now: justAfterMidnight })).not.toContain(
      ':',
    );
  });
});
