import { Virtualizer } from '@tanstack/react-virtual';
import { describe, expect, it } from 'vitest';
import { premeasureChunkIndexes } from '../idle-premeasure';

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

describe('useIdlePremeasure seeding mechanism', () => {
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

describe('warm-then-measure seeding (Mermaid rows)', () => {
  it('GREEN: a row seeded at its cache-warmed real height settles with zero adjustment, same as any other row', () => {
    // The mechanism `useIdlePremeasure` relies on (resizeItem's zero-delta no-op) doesn't distinguish a
    // Mermaid row from a text row — it only cares whether the seeded height matches the later real measure.
    // The `warmed` gate exists purely to make that true for Mermaid rows too: once mermaidCache is warm, the
    // hidden layer's offsetHeight read for that row IS its real height, so seeding behaves exactly like the
    // existing GREEN case above. This asserts the gate doesn't change the seeding contract itself.
    const { v, adjustmentsPassed } = buildVirtualizer();
    const idx = 95;
    const realMermaidHeight = 812; // e.g. a tall flowchart's real rendered height, read from a warm cache hit

    v.resizeItem(idx, realMermaidHeight);
    const totalAfterSeed = v.getTotalSize();

    adjustmentsPassed.length = 0;
    v.resizeItem(idx, realMermaidHeight);

    expect(v.getTotalSize()).toBe(totalAfterSeed);
    expect(adjustmentsPassed).toEqual([]);
  });

  it('RED (what the fix removes): seeding a cold-placeholder height still causes a shift once the real SVG lands', () => {
    // Before warming, a Mermaid row's offsetHeight at seed time is the SOURCE-heuristic placeholder, not the
    // real rendered height — so the later real measurement (once mermaid.render resolves) is a non-zero
    // delta, exactly like an unseeded row. This is the bug the WARM phase eliminates by making the seeded
    // height already real.
    const { v, adjustmentsPassed } = buildVirtualizer();
    const idx = 95;
    const placeholderHeight = 320; // mermaidReservePx cold estimate
    const realHeight = 812; // what the SVG actually measures once it lands

    v.resizeItem(idx, placeholderHeight);
    adjustmentsPassed.length = 0;
    v.resizeItem(idx, realHeight);

    expect(adjustmentsPassed.length).toBeGreaterThan(0);
  });
});

describe('premeasure chunk planning', () => {
  it('measures tail appends without skipping the older unmeasured backlog', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ key: String(i) }));
    const measured = new Set<string>();
    const isMeasured = (key: string) => measured.has(key);

    const tail = premeasureChunkIndexes(items, items.length, 3, isMeasured);
    expect(tail).toEqual([4, 5, 6]);
    for (const idx of tail) measured.add(items[idx].key);

    const appended = [...items, { key: '7' }];
    const appendedChunk = premeasureChunkIndexes(appended, appended.length, 3, isMeasured);
    expect(appendedChunk).toEqual([2, 3, 7]);
    for (const idx of appendedChunk) measured.add(appended[idx].key);

    expect(premeasureChunkIndexes(appended, appendedChunk[0], 3, isMeasured)).toEqual([0, 1]);
  });
});
