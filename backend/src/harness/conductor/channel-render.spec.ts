import { describe, it, expect } from 'vitest';
import type { ChannelMsg } from '../channel/channel.types';
import {
  formatGap,
  formatStamp,
  buildTimeContext,
  withDividers,
  sameCalendarDay,
  GAP_THRESHOLD_DEFAULT_MS,
} from './channel-render';

/** Minimal ChannelMsg fixture. */
const msg = (overrides: Partial<ChannelMsg> & { createdAt: number }): ChannelMsg => ({
  seq: 0,
  id: 'test',
  channelId: 'tui:test',
  author: 'Dennis',
  authorId: 'dennis',
  text: 'hello',
  ...overrides,
});

describe('channel-render — formatGap', () => {
  it('returns minutes below one hour', () => {
    expect(formatGap(30 * 60_000)).toBe('30 minutes later');
    expect(formatGap(1 * 60_000)).toBe('1 minute later');
  });

  it('returns hours between 1h and 24h', () => {
    expect(formatGap(3 * 3_600_000)).toBe('3 hours later');
    expect(formatGap(1 * 3_600_000)).toBe('1 hour later');
  });

  it('returns days at 24h and above', () => {
    expect(formatGap(2 * 86_400_000)).toBe('2 days later');
    expect(formatGap(1 * 86_400_000)).toBe('1 day later');
  });
});

describe('channel-render — formatStamp', () => {
  it('returns a non-empty, human-readable string for any epoch ms', () => {
    const s = formatStamp(Date.now());
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
    // Should contain a colon (the time separator), e.g. "21:30"
    expect(s).toMatch(/\d{2}:\d{2}/);
  });
});

describe('channel-render — sameCalendarDay', () => {
  it('returns true for two timestamps on the same day', () => {
    const base = new Date('2025-06-10T10:00:00').getTime();
    const same = new Date('2025-06-10T23:59:00').getTime();
    expect(sameCalendarDay(base, same)).toBe(true);
  });

  it('returns false for timestamps on different days', () => {
    const day1 = new Date('2025-06-10T23:30:00').getTime();
    const day2 = new Date('2025-06-11T00:30:00').getTime();
    expect(sameCalendarDay(day1, day2)).toBe(false);
  });
});

describe('channel-render — withDividers', () => {
  const GAP = GAP_THRESHOLD_DEFAULT_MS; // 1h

  it('returns just message items when no gap exceeds the threshold', () => {
    const t0 = new Date('2025-06-10T10:00:00').getTime();
    const t1 = t0 + 30 * 60_000; // 30 min later — below threshold
    const msgs = [
      msg({ id: 'a', createdAt: t0 }),
      msg({ id: 'b', createdAt: t1 }),
    ];
    const items = withDividers(msgs, GAP);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === 'message')).toBe(true);
  });

  it('inserts a time-divider between messages separated by at least the threshold', () => {
    const t0 = new Date('2025-06-10T10:00:00').getTime();
    const t1 = t0 + 3 * 3_600_000; // 3 hours later — above 1h threshold
    const msgs = [
      msg({ id: 'a', createdAt: t0 }),
      msg({ id: 'b', createdAt: t1 }),
    ];
    const items = withDividers(msgs, GAP);
    expect(items).toHaveLength(3); // msg, divider, msg
    expect(items[0]).toMatchObject({ kind: 'message' });
    expect(items[1]).toMatchObject({ kind: 'time-divider' });
    expect(items[2]).toMatchObject({ kind: 'message' });
    expect(items[1].kind === 'time-divider' && items[1].label).toMatch(/3 hours later/);
  });

  it('inserts a time-divider at a calendar-day boundary regardless of gap size', () => {
    // Midnight crossing: 11pm → 1am = 2h gap — below 1h threshold in ms BUT crosses a day.
    const t0 = new Date('2025-06-10T23:00:00').getTime();
    const t1 = new Date('2025-06-11T01:00:00').getTime(); // 2h later, different day
    const msgs = [
      msg({ id: 'a', createdAt: t0 }),
      msg({ id: 'b', createdAt: t1 }),
    ];
    // With a very high threshold (10h), the 2h gap wouldn't normally qualify — but the day
    // boundary rule fires regardless.
    const items = withDividers(msgs, 10 * 3_600_000);
    expect(items).toHaveLength(3);
    expect(items[1].kind).toBe('time-divider');
  });

  it('handles a single message with no dividers', () => {
    const items = withDividers([msg({ createdAt: Date.now() })], GAP);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('message');
  });

  it('skips dividers for zero-stamped messages (synthetic / pre-feature)', () => {
    const msgs = [
      msg({ id: 'a', createdAt: 0 }),
      msg({ id: 'b', createdAt: 0 }),
    ];
    const items = withDividers(msgs, GAP);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === 'message')).toBe(true);
  });

  it('handles an empty array', () => {
    expect(withDividers([], GAP)).toHaveLength(0);
  });
});

describe('channel-render — buildTimeContext', () => {
  const GAP = GAP_THRESHOLD_DEFAULT_MS;

  it('always includes a "Current time:" line', () => {
    const ctx = buildTimeContext([], undefined, GAP);
    expect(ctx).toContain('Current time:');
  });

  it('includes a gap note when the leading gap exceeds the threshold', () => {
    const prevTs = Date.now() - 3 * 3_600_000; // 3 hours ago
    const freshTs = Date.now() - 1_000; // almost now
    const fresh = [msg({ createdAt: freshTs })];
    const ctx = buildTimeContext(fresh, prevTs, GAP);
    expect(ctx).toContain('Current time:');
    expect(ctx).toContain('[3 hours since the previous message in this conversation]');
  });

  it('omits the gap note when the leading gap is below the threshold', () => {
    // Fixed LOCAL-noon stamps, not Date.now(): a relative "30 min ago" crosses the calendar-day
    // boundary when the suite runs shortly after midnight, and the day-boundary rule fires the
    // note regardless of the threshold (this exact flake happened at 00:03).
    const noon = new Date('2026-06-10T12:00:00').getTime();
    const prevTs = noon - 30 * 60_000; // 30 min before noon — same calendar day
    const fresh = [msg({ createdAt: noon })];
    const ctx = buildTimeContext(fresh, prevTs, GAP);
    expect(ctx).toContain('Current time:');
    expect(ctx).not.toContain('since the previous message');
  });

  it('omits the gap note when prevCreatedAt is undefined (no prior history)', () => {
    const freshTs = Date.now();
    const fresh = [msg({ createdAt: freshTs })];
    const ctx = buildTimeContext(fresh, undefined, GAP);
    expect(ctx).toContain('Current time:');
    expect(ctx).not.toContain('since the previous message');
  });

  it('omits the gap note when the fresh batch is empty', () => {
    const ctx = buildTimeContext([], Date.now() - 5 * 3_600_000, GAP);
    expect(ctx).toContain('Current time:');
    expect(ctx).not.toContain('since the previous message');
  });
});
