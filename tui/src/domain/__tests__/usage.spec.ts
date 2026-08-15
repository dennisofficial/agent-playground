import { describe, expect, it } from 'bun:test';
import { EEngine } from '../../generated/prisma/enums.js';
import {
  budgetFor,
  formatCountdown,
  formatPercent,
  isPressured,
  meterBand,
  meterFill,
  resolveContextLimit,
  toPercent,
  windowKeyFor,
  windowPercent,
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
    // Exactly on a cell boundary stays on it — ceil only moves a partial cell, so 40% is two cells
    // and not three. Otherwise the bar would run a cell ahead of itself the whole way up.
    [40, 2],
    [41, 3],
    [61, 4],
    [91, 5],
    [100, 5],
  ])('%i%% fills %i of five cells', (utilization, expected) => {
    expect(meterFill(utilization, 5)).toBe(expected);
  });

  it('rounds a partial cell UP, so the gauge never draws headroom that is not there', () => {
    // The direction matters more than the precision on something meant to be glanced at: 61% drawing
    // three of five cells reads as "not yet two thirds", which is the reading that loses a session.
    expect(meterFill(61, 5)).toBe(4);
    expect(meterFill(81, 5)).toBe(5);
  });

  it('never rounds a live window down to an empty gauge', () => {
    // Drawing 1% identically to `—` would make "barely started" and "we have no idea" the same
    // picture, and unknown is a real state here. Rounding up gives this without a special case.
    expect(meterFill(1, 5)).toBe(1);
    expect(meterFill(0, 5)).toBe(0);
  });

  it('never overflows the track, however the arithmetic lands', () => {
    // The empty half is drawn as `cells - filled`, so a fill above `cells` would render a negative
    // repeat count and throw.
    expect(meterFill(100, 5)).toBe(5);
    expect(meterFill(140, 5)).toBe(5);
  });

  it('scales to whatever cell count the glyph set asks for', () => {
    expect(meterFill(50, 6)).toBe(3);
    expect(meterFill(100, 6)).toBe(6);
  });
});

describe('meterBand', () => {
  it.each([
    ['fiveHour', 64, 'normal'],
    ['fiveHour', 65, 'warn'],
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
    expect(isPressured(meterBand('fiveHour', 20))).toBe(false);
    expect(isPressured(meterBand('fiveHour', null))).toBe(false);
    expect(isPressured(meterBand('fiveHour', 65))).toBe(true);
    expect(isPressured(meterBand('fiveHour', 100))).toBe(true);
  });
});

describe('windowPercent', () => {
  it('reads occupancy of the physical window, not of the rotation budget', () => {
    // The same 228_600-token session the budget meter drew as 127%: against a million-token window
    // it is 23%, and that is now deliberately what the gauge says.
    expect(windowPercent({ tokens: 228_600, limit: 1_000_000 })).toBe(23);
    expect(windowPercent({ tokens: 120_000, limit: 200_000 })).toBe(60);
  });

  it('clamps at the wall, because there is nothing past the window', () => {
    expect(windowPercent({ tokens: 260_000, limit: 200_000 })).toBe(100);
    expect(windowPercent({ tokens: -1, limit: 200_000 })).toBe(0);
  });

  it('reads zero rather than dividing by an unreported window', () => {
    expect(windowPercent({ tokens: 40_000, limit: 0 })).toBe(0);
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

describe('budgetFor', () => {
  /**
   * The VALUES here are seeds, not measurements — and the Opus row is now a seed being tried ABOVE
   * design 06 §3's 180K/300K, because the soft tier advises rather than orders and nudging early
   * costs a seam the work did not need. Ticket 16 has not reported the real curve yet. What these
   * tests pin is the shape and the two relations that are not guesses: the smaller models get less
   * runway, and no budget may exceed the window it is measured against.
   */
  it('gives the Opus class the raised trial budget', () => {
    expect(budgetFor({ engine: EEngine.claude, model: 'claude-opus-5' })).toEqual({
      soft: 300_000,
      hard: 420_000,
    });
  });

  it('leaves the agent 120K of runway to pick its own seam before Atlas stops deferring', () => {
    // The soft→hard gap is the whole point of the two-tier wording: it is how long the advisory gets
    // to work before it escalates. Pinned rather than left to fall out of the two numbers, because
    // scaling `soft` again must be a decision about this gap and not an accident to it.
    const opus = budgetFor({ engine: EEngine.claude, model: 'claude-opus-5' });
    expect(opus.hard - opus.soft).toBe(120_000);
  });

  it('gives the models that degrade earlier much less runway', () => {
    // ~32K vs ~64K effective context is the one relative fact the research supports (06 §5). This row
    // stands on that claim alone — it is deliberately NOT re-derived from the Opus row, which is a
    // trial of a cost trade-off and says nothing about how long these models stay sharp.
    const sonnet = budgetFor({ engine: EEngine.claude, model: 'claude-sonnet-5' });
    expect(sonnet.soft).toBe(90_000);
    expect(sonnet.hard).toBe(150_000);
    expect(sonnet.soft).toBeLessThan(
      budgetFor({ engine: EEngine.claude, model: 'claude-opus-5' }).soft,
    );
  });

  it('never budgets past the window, because past the window is the wall', () => {
    // A 200K model cannot spend the Opus row's 300K soft budget — that is not a hand-off threshold,
    // it is a hundred thousand tokens past the point where the next request is refused. The caps
    // matter more now the generous row is generous by another 120K.
    const haiku = budgetFor({ engine: EEngine.claude, model: 'claude-haiku-4-5-20251001' });
    expect(haiku.soft).toBeLessThanOrEqual(200_000 * 0.55);
    expect(haiku.hard).toBeLessThanOrEqual(200_000 * 0.9);

    // The row applied to a small window, which is the case the caps exist for: 300K/420K clamped to
    // 110K/180K rather than budgeting straight through the wall.
    const cramped = budgetFor({
      engine: EEngine.claude,
      model: 'claude-opus-5',
      contextLimit: 200_000,
    });
    expect(cramped).toEqual({ soft: 110_000, hard: 180_000 });
  });

  it('takes the window the engine REPORTED over anything read off the model name', () => {
    // Codex's window moves remotely, so the reported number wins. Legacy pinned a constant and had
    // no way to notice when it stopped being true.
    const reported = budgetFor({
      engine: EEngine.codex,
      model: 'gpt-5.6-sol',
      contextLimit: 100_000,
    });
    expect(reported.soft).toBe(55_000);
    expect(reported.hard).toBe(90_000);
  });

  it('gives an unknown model the conservative row rather than the generous one', () => {
    // Guessing high nudges too late, and too late is the failure this whole mechanism exists for.
    const unknown = budgetFor({ engine: EEngine.claude, model: 'something-else' });
    expect(unknown.soft).toBeLessThan(
      budgetFor({ engine: EEngine.claude, model: 'claude-opus-5' }).soft,
    );
  });
});
