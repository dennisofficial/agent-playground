import { describe, expect, it } from 'bun:test';
import type { TurnUsage } from '../message.js';
import { addTurnUsage } from '../turn-usage.js';

/**
 * What a held turn cost.
 *
 * The numbers below are the real ones from a tape holding two results on a single engine session:
 * `num_turns=18, out=4191, cost=$3.71` then `num_turns=9, out=2959, cost=$1.83`. The counters RESET
 * between them, which is the whole reason this function exists — booking the second alone loses the
 * first, and that is what the ledger did before the turn could be held open.
 */

const FIRST: TurnUsage = {
  inputTokens: 41,
  outputTokens: 4_191,
  cacheReadTokens: 1_200_000,
  cacheWriteTokens: 90_000,
  costUsd: 3.71,
  model: 'claude-opus-5',
};

const SECOND: TurnUsage = {
  inputTokens: 17,
  outputTokens: 2_959,
  cacheReadTokens: 800_000,
  cacheWriteTokens: 40_000,
  costUsd: 1.83,
  model: 'claude-opus-5',
};

describe('addTurnUsage', () => {
  it('sums every token counter across the cycles of one turn', () => {
    expect(addTurnUsage({ total: FIRST, next: SECOND })).toMatchObject({
      inputTokens: 58,
      outputTokens: 7_150,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 130_000,
    });
  });

  it('sums the cost, so the ledger bills the turn and not its last cycle', () => {
    expect(addTurnUsage({ total: FIRST, next: SECOND })?.costUsd).toBeCloseTo(5.54, 5);
  });

  it('is the identity on an absent operand — absent is a gap, not a zero', () => {
    expect(addTurnUsage({ total: undefined, next: SECOND })).toEqual(SECOND);
    expect(addTurnUsage({ total: FIRST, next: undefined })).toEqual(FIRST);
    expect(addTurnUsage({ total: undefined, next: undefined })).toBeUndefined();
  });

  it('keeps a cost that only one side reported', () => {
    const free: TurnUsage = { ...SECOND, costUsd: undefined };
    expect(addTurnUsage({ total: FIRST, next: free })?.costUsd).toBe(3.71);
    expect(addTurnUsage({ total: free, next: FIRST })?.costUsd).toBe(3.71);
  });

  it('reports no cost at all when neither side had one — a subscription turn is not $0.00', () => {
    const free: TurnUsage = { ...FIRST, costUsd: undefined };
    const alsoFree: TurnUsage = { ...SECOND, costUsd: undefined };
    const summed = addTurnUsage({ total: free, next: alsoFree });

    expect(summed?.costUsd).toBeUndefined();
    expect('costUsd' in (summed ?? {})).toBe(false);
  });

  it('names the heavier side rather than the one that spoke last', () => {
    const fallback: TurnUsage = { ...SECOND, model: 'claude-sonnet-4-5' };
    // The heavier cycle wins whichever side it arrives on.
    expect(addTurnUsage({ total: FIRST, next: fallback })?.model).toBe('claude-opus-5');
    expect(addTurnUsage({ total: fallback, next: FIRST })?.model).toBe('claude-opus-5');
  });

  it('takes the other side\'s model when the heavier one names none', () => {
    const anonymous: TurnUsage = { ...FIRST, model: undefined };
    expect(addTurnUsage({ total: anonymous, next: SECOND })?.model).toBe('claude-opus-5');
  });

  /**
   * First-past-the-post, not a true heaviest-model tally: each cycle is weighed against the running
   * TOTAL rather than against the other model's share. Pinned so the limitation is a decision on the
   * record instead of a surprise — see the rationale in `turn-usage.ts`.
   */
  it('weighs each cycle against the running total, which a third cycle cannot overturn', () => {
    const opus: TurnUsage = { ...FIRST, outputTokens: 4_000, model: 'claude-opus-5' };
    const sonnet: TurnUsage = { ...SECOND, outputTokens: 3_000, model: 'claude-sonnet-4-5' };

    const twoCycles = addTurnUsage({ total: opus, next: sonnet });
    const threeCycles = addTurnUsage({ total: twoCycles, next: sonnet });

    expect(threeCycles?.outputTokens).toBe(10_000);
    expect(threeCycles?.model).toBe('claude-opus-5');
  });
});
