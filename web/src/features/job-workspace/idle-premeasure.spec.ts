import { Virtualizer } from "@tanstack/react-virtual";
import { describe, expect, it } from "vitest";

/**
 * Deterministic RED→GREEN for the pre-measurement seeding mechanism `useIdlePremeasure` relies on:
 * `resizeItem(index, size)` computes `delta = size - itemSizeCache.get(key)` and early-returns (no notify,
 * no scroll adjustment) when `delta === 0`. So seeding a row's EXACT height off-screen, ahead of time, makes
 * the live viewport's later `measureElement` measurement of that same row a no-op — it never triggers
 * `applyScrollAdjustment`, which is what iOS WebKit defers during touch momentum into the visible jump this
 * pass eliminates. An UNSEEDED row's first real measurement, by contrast, always has a non-zero delta (it's
 * moving off the `estimateSize` guess) and does trigger an adjustment.
 *
 * This drives a headless Virtualizer with stubbed observers (as `scroll-compensation.spec.ts` does) so the
 * outcome is exact, with no browser, DOM, or React rendering involved — a pure virtual-core mechanism proof.
 */
function buildVirtualizer() {
  let scrollTop = 0;
  const el = {} as Element;
  const adjustmentsPassed: number[] = [];

  const v = new Virtualizer<Element, Element>({
    count: 200,
    getScrollElement: () => el,
    estimateSize: () => 100,
    overscan: 8,
    observeElementRect: (_i, cb) => {
      cb({ width: 800, height: 900 });
      return undefined;
    },
    observeElementOffset: (_i, cb) => {
      cb(scrollTop, false);
      return undefined;
    },
    scrollToFn: (offset, { adjustments }) => {
      adjustmentsPassed.push(adjustments ?? 0);
      scrollTop = offset + (adjustments ?? 0);
    },
    initialRect: { width: 800, height: 900 },
  });

  v._didMount();
  v._willUpdate();

  // Park the viewport well below the target row (idx 95, estimated start 9500) so it sits ABOVE the
  // viewport — exactly where a fresh tall row scrolling up would be re-measured for the first time.
  v.scrollOffset = 10000;
  v.calculateRange();
  v.getVirtualItems();

  return { v, adjustmentsPassed };
}

describe("useIdlePremeasure seeding mechanism", () => {
  it("RED: an unseeded row's first real measure produces a delta and a scroll adjustment", () => {
    const { v, adjustmentsPassed } = buildVirtualizer();
    const idx = 95;

    const totalBefore = v.getTotalSize();
    adjustmentsPassed.length = 0;
    // The live viewport's own measureElement running on first mount, straight from the estimate.
    v.resizeItem(idx, 350);

    expect(v.getTotalSize()).not.toBe(totalBefore);
    expect(adjustmentsPassed.length).toBeGreaterThan(0);
  });

  it("GREEN: seeding a row's exact height ahead of time makes the live measure a no-op", () => {
    const { v, adjustmentsPassed } = buildVirtualizer();
    const idx = 95;

    // The off-screen pre-measurement pass seeds the exact height before the row is ever viewport-measured.
    v.resizeItem(idx, 350);
    const totalAfterSeed = v.getTotalSize();

    // The live viewport's own measureElement later runs on mount, measuring the SAME real height.
    adjustmentsPassed.length = 0;
    v.resizeItem(idx, 350);

    expect(v.getTotalSize()).toBe(totalAfterSeed);
    expect(adjustmentsPassed).toEqual([]);
  });
});
