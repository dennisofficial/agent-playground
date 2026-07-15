import { describe, expect, it } from 'vitest';
import {
  detectSessionLimitText,
  limitFromRateEvent,
  parseResetAt,
} from './session-limit';

describe('limitFromRateEvent', () => {
  it('returns a hit with ISO resetAt + metadata for a rejected frame', () => {
    const resetsAt = Date.parse('2026-07-09T22:00:00.000Z');
    const hit = limitFromRateEvent({
      status: 'rejected',
      resetsAt,
      rateLimitType: 'five_hour',
      utilization: 100,
    });
    expect(hit).toEqual({
      resetAt: '2026-07-09T22:00:00.000Z',
      rateLimitType: 'five_hour',
      utilization: 100,
    });
  });

  it('interprets the SDK epoch-SECONDS resetsAt as 2026, not 1970', () => {
    // Real `rate_limit_event` frames carry `resetsAt` in epoch SECONDS (10-digit, e.g. 1783650000). A naive
    // `new Date(seconds)` treats it as ms and lands in Jan 1970 — the bug this guards against.
    const seconds = 1783650000;
    const hit = limitFromRateEvent({
      status: 'rejected',
      resetsAt: seconds,
      rateLimitType: 'five_hour',
    });
    expect(hit?.resetAt).toBe(new Date(seconds * 1000).toISOString());
    expect(new Date(hit!.resetAt as string).getUTCFullYear()).toBe(2026);
  });

  it('passes an already-millisecond resetsAt through unchanged', () => {
    const ms = Date.parse('2026-07-09T22:00:00.000Z');
    expect(
      limitFromRateEvent({ status: 'rejected', resetsAt: ms })?.resetAt,
    ).toBe('2026-07-09T22:00:00.000Z');
  });

  it('returns null for an allowed_warning frame', () => {
    expect(
      limitFromRateEvent({ status: 'allowed_warning', utilization: 82 }),
    ).toBeNull();
  });

  it('returns null for an allowed frame', () => {
    expect(limitFromRateEvent({ status: 'allowed' })).toBeNull();
  });

  it('omits resetAt when the rejected frame carries no resetsAt', () => {
    expect(limitFromRateEvent({ status: 'rejected' })).toEqual({
      resetAt: undefined,
      rateLimitType: undefined,
      utilization: undefined,
    });
  });
});

describe('detectSessionLimitText', () => {
  it('is true for the printed limit lines', () => {
    expect(
      detectSessionLimitText("You've hit your session limit · resets 5:20pm"),
    ).toBe(true);
    expect(detectSessionLimitText("You've hit your usage limit")).toBe(true);
    expect(detectSessionLimitText('usage limit reached')).toBe(true);
  });

  it('is false for ordinary prose and nullish input', () => {
    expect(
      detectSessionLimitText('I reached the end of the file and hit save.'),
    ).toBe(false);
    expect(detectSessionLimitText(null)).toBe(false);
    expect(detectSessionLimitText(undefined)).toBe(false);
  });
});

describe('parseResetAt', () => {
  it('resolves a clock time later today to that local instant, strictly after now', () => {
    const now = new Date(2026, 6, 9, 9, 0, 0, 0); // 9:00am local
    const iso = parseResetAt('resets 5:20pm', now);
    expect(iso).toBeDefined();
    const reset = new Date(iso!);
    expect(reset.getHours()).toBe(17);
    expect(reset.getMinutes()).toBe(20);
    expect(reset.getTime()).toBeGreaterThan(now.getTime());
    expect(reset.getDate()).toBe(9);
  });

  it('rolls to tomorrow when the clock time already passed today', () => {
    const now = new Date(2026, 6, 9, 18, 0, 0, 0); // 6:00pm local
    const iso = parseResetAt('resets 5:20pm', now);
    expect(iso).toBeDefined();
    const reset = new Date(iso!);
    expect(reset.getHours()).toBe(17);
    expect(reset.getMinutes()).toBe(20);
    expect(reset.getDate()).toBe(10);
    expect(reset.getTime()).toBeGreaterThan(now.getTime());
  });

  it('handles noon/midnight and a bare-hour form, ignoring trailing timezone text', () => {
    const now = new Date(2026, 6, 9, 6, 0, 0, 0);
    const noon = new Date(parseResetAt('resets 12pm (UTC)', now)!);
    expect(noon.getHours()).toBe(12);
    const fivePm = new Date(parseResetAt('resets 5pm', now)!);
    expect(fivePm.getHours()).toBe(17);
  });

  it('returns undefined for an unparseable string', () => {
    expect(parseResetAt('resets soon')).toBeUndefined();
    expect(parseResetAt('no time here at all')).toBeUndefined();
  });
});
