import { describe, expect, it } from 'bun:test';
import {
  formatCountdown,
  formatPercent,
  isPressured,
  meterBand,
  meterFill,
  resolveContextLimit,
  toPercent,
  windowKeyFor,
} from '../usage.js';

describe('unknown is a real state, not zero', () => {
  it('renders an em dash rather than 0%', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0)).toBe('0%');
  });

  it('draws an empty gauge for unknown, not a zeroed one', () => {
    expect(meterFill(null, 5)).toBe(0);
  });

  it('gives unknown its own band rather than colouring it as healthy', () => {
    expect(meterBand('fiveHour', null)).toBe('unknown');
  });
});

describe('meterFill', () => {
  it.each([
    [0, 0],
    [12, 1],
    [34, 2],
    [61, 3],
    [91, 5],
    [100, 5],
  ])('%i%% fills %i of five cells', (utilization, expected) => {
    expect(meterFill(utilization, 5)).toBe(expected);
  });

  it('never rounds a live window down to an empty gauge', () => {
    // 1% rounds to zero cells. Drawing that identically to `—` would make "barely started" and
    // "we have no idea" the same picture, and unknown is a real state here.
    expect(meterFill(1, 5)).toBe(1);
    expect(meterFill(0, 5)).toBe(0);
  });

  it('scales to whatever cell count the glyph set asks for', () => {
    expect(meterFill(50, 6)).toBe(3);
    expect(meterFill(100, 6)).toBe(6);
  });
});

describe('meterBand', () => {
  it.each([
    ['ctx', 59, 'normal'],
    ['ctx', 60, 'warn'],
    ['ctx', 78, 'hot'],
    ['ctx', 90, 'red'],
    ['fiveHour', 82, 'hot'],
    ['fiveHour', 93, 'red'],
    ['sevenDay', 69, 'normal'],
    ['sevenDay', 95, 'red'],
  ] as const)('%s at %i%% is %s', (key, value, expected) => {
    expect(meterBand(key, value)).toBe(expected);
  });

  it('treats a full window as a different KIND of state, not a redder one', () => {
    // At 100% there is no quantity left to report, which is what lets the strip drop the bar and the
    // percent and show only the countdown.
    expect(meterBand('fiveHour', 99)).toBe('red');
    expect(meterBand('fiveHour', 100)).toBe('spent');
  });

  it('calls everything above normal pressured, so the ink schemes agree with the ramp', () => {
    expect(isPressured(meterBand('ctx', 20))).toBe(false);
    expect(isPressured(meterBand('ctx', null))).toBe(false);
    expect(isPressured(meterBand('ctx', 60))).toBe(true);
    expect(isPressured(meterBand('ctx', 100))).toBe(true);
  });
});

describe('toPercent', () => {
  it('accepts both 0..1 and 0..100 forms', () => {
    expect(toPercent(0.34)).toBe(34);
    expect(toPercent(61)).toBe(61);
  });

  it('clamps out-of-range percentages', () => {
    expect(toPercent(150)).toBe(100);
    expect(toPercent(-5)).toBe(0);
  });

  it('reports unknown as null rather than zero', () => {
    expect(toPercent(undefined)).toBeNull();
  });

  it('treats anything above 1 as already-a-percent, which is the ambiguous edge', () => {
    // The 0..1-vs-0..100 heuristic has to pick a side at 1. Values just above it read as
    // percentages, so 1.5 is 2%, not 100%. Worth pinning: it is the one input where a wrong
    // guess would silently show a full meter as empty.
    expect(toPercent(1)).toBe(100);
    expect(toPercent(1.5)).toBe(2);
  });
});

describe('windowKeyFor', () => {
  it('folds every weekly variant onto one meter and ignores the rest', () => {
    expect(windowKeyFor('five_hour')).toBe('fiveHour');
    expect(windowKeyFor('seven_day_opus')).toBe('sevenDay');
    expect(windowKeyFor('overage')).toBeNull();
    expect(windowKeyFor(undefined)).toBeNull();
  });
});

describe('formatCountdown', () => {
  const now = Date.parse('2026-08-02T20:00:00Z');

  it('is compact because it shares a line with three meters', () => {
    expect(formatCountdown('2026-08-02T22:14:00Z', now)).toBe('2h14m');
    expect(formatCountdown('2026-08-02T20:41:00Z', now)).toBe('41m');
  });

  it('says "now" rather than a negative once the window has passed', () => {
    expect(formatCountdown('2026-08-02T19:00:00Z', now)).toBe('now');
  });

  it('is empty when there is no reset time', () => {
    expect(formatCountdown(null, now)).toBe('');
  });
});

describe('resolveContextLimit', () => {
  it('gives the big window to the explicit [1m] alias', () => {
    expect(resolveContextLimit('claude-sonnet-4-6[1m]')).toBe(1_000_000);
  });

  it('gives the big window to the million-token families by bare id', () => {
    // Pinned against a real `result.modelUsage` frame: `claude-opus-5` reports
    // `contextWindow: 1000000`. Reading it as 200k put the meter five times too high.
    expect(resolveContextLimit('claude-opus-5')).toBe(1_000_000);
    expect(resolveContextLimit('claude-opus-5-20260714')).toBe(1_000_000);
    expect(resolveContextLimit('claude-sonnet-5')).toBe(1_000_000);
  });

  it('keeps everything else at 200k', () => {
    // Same frame, other half: `claude-haiku-4-5-20251001` reports `contextWindow: 200000`.
    expect(resolveContextLimit('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(resolveContextLimit('something-else')).toBe(200_000);
    expect(resolveContextLimit(undefined)).toBe(200_000);
  });
});
