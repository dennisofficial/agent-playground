import { describe, expect, it } from 'bun:test';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import { EAttentionCourt } from '../attention.js';
import {
  deletionCost,
  formatWhen,
  jobAttention,
  jobSummary,
  jobsLayout,
  type JobThreadSource,
} from '../jobs-list.js';

function jobThread(fields: Partial<JobThreadSource> & { id: string }): JobThreadSource {
  return { closed: false, lastMessageAt: null, lastSeenAt: null, ...fields };
}

describe('jobsLayout', () => {
  it('gives the status its widest form when the terminal can afford it', () => {
    expect(jobsLayout(120).status).toBe(14);
  });

  it('leaves the widest form room for the longest verb', () => {
    expect(jobsLayout(120).status).toBeGreaterThanOrEqual('start a phase'.length + 1);
  });

  it('steps the status down before it starves the title', () => {
    const wide = jobsLayout(120);
    const narrow = jobsLayout(40);
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

describe('jobAttention', () => {
  it('unions its threads: working and owing a confirm at the same time', () => {
    const attention = jobAttention({
      threads: [
        jobThread({ id: 'planner' }),
        jobThread({ id: 'builder-api' }),
        jobThread({ id: 'builder-ui', closed: true }),
      ],
      runningThreadIds: ['builder-api'],
      proposalThreadIds: ['planner'],
    });

    // The word goes to the obligation; the spinner is a separate channel and does not swallow it.
    expect(attention.label).toBe('confirm');
    expect(attention.court).toBe(EAttentionCourt.yours);
  });

  it('asks for a new phase once every thread of the job is closed', () => {
    const attention = jobAttention({
      threads: [jobThread({ id: 't1', closed: true }), jobThread({ id: 't2', closed: true })],
      runningThreadIds: [],
    });

    expect(attention.label).toBe('start a phase');
  });

  it('says shipped instead, once a pull request exists', () => {
    const attention = jobAttention({
      threads: [jobThread({ id: 't1', closed: true })],
      runningThreadIds: [],
      hasPullRequest: true,
    });

    expect(attention.label).toBe('shipped');
    expect(attention.court).toBe(EAttentionCourt.external);
  });

  it('carries unread up from any one thread', () => {
    const attention = jobAttention({
      threads: [
        jobThread({ id: 't1' }),
        jobThread({
          id: 't2',
          lastMessageAt: new Date('2026-08-11T10:00:00Z'),
          lastSeenAt: new Date('2026-08-11T09:00:00Z'),
        }),
      ],
      runningThreadIds: [],
    });

    expect(attention.unseen).toBe(true);
  });

  it('reads a job with no threads at all as one needing a phase', () => {
    expect(jobAttention({ threads: [], runningThreadIds: [] }).label).toBe('start a phase');
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
