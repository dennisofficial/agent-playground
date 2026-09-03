import { describe, expect, it } from "bun:test";

import { estimateCostUsd } from "../cost";

const COST = { inputPerMillion: 3, outputPerMillion: 15 };

const spendOf = (
  over: Partial<Parameters<typeof estimateCostUsd>[0]["spend"]> = {},
) => ({
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

describe("what a turn cost", () => {
  it("bills plain input and output at the rates the card carries", () => {
    const dollars = estimateCostUsd({
      spend: spendOf({ outputTokens: 1_000_000 }),
      cost: COST,
    });

    expect(dollars).toBeCloseTo(18, 6);
  });

  /**
   * Cache reads sit inside `inputTokens` rather than on top, so a million tokens all read from
   * cache costs a tenth of a million billed plainly — not eleven tenths of it.
   */
  it("takes a cache read out of the plain input before billing it at a tenth", () => {
    const dollars = estimateCostUsd({
      spend: spendOf({ cacheReadTokens: 1_000_000 }),
      cost: COST,
    });

    expect(dollars).toBeCloseTo(0.3, 6);
  });

  it("bills a cache write at a quarter over the input rate", () => {
    const dollars = estimateCostUsd({
      spend: spendOf({ cacheWriteTokens: 1_000_000 }),
      cost: COST,
    });

    expect(dollars).toBeCloseTo(3.75, 6);
  });

  it("never bills negative input when the cache figures overshoot the total", () => {
    const dollars = estimateCostUsd({
      spend: spendOf({ inputTokens: 0, cacheReadTokens: 1_000_000 }),
      cost: COST,
    });

    expect(dollars).toBeCloseTo(0.3, 6);
  });

  it("costs nothing when nothing was spent", () => {
    expect(
      estimateCostUsd({ spend: spendOf({ inputTokens: 0 }), cost: COST }),
    ).toBe(0);
  });
});
