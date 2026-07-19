import { Virtualizer } from '@tanstack/react-virtual';
import { describe, expect, it } from 'vitest';
import { compensateAboveViewportResize } from '../scroll-compensation';

/**
 * Deterministic RED→GREEN for Cause B: an already-measured row ABOVE the viewport
 * re-measures taller during an upward (backward) scroll.
 *
 * @tanstack/virtual-core's default deliberately skips scroll-offset compensation in
 * exactly this case, so on-screen content slides down (the transcript "pushes down"
 * while scrolling up). {@link compensateAboveViewportResize} overrides that.
 *
 * This drives a headless Virtualizer with stubbed observers so the outcome is exact,
 * with no browser or async timing. We observe the `scrollOffset` delta (equivalently
 * the `adjustments` handed to `scrollToFn`): virtual-core folds `scrollAdjustments`
 * back into `scrollOffset` and resets it to 0, so `scrollAdjustments` alone reads 0.
 */
function measureBackwardResize(withFix: boolean) {
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
  if (withFix) {
    v.shouldAdjustScrollPositionOnItemSizeChange = compensateAboveViewportResize;
  }

  // Park the viewport well below the target row (idx 95, start 9500) so it sits ABOVE the viewport.
  v.scrollOffset = 10000;
  v.calculateRange();
  v.getVirtualItems();

  const idx = 95;
  // Prime the size cache with a real (non-zero) delta while direction is null — `resizeItem`
  // no-ops when delta===0 and never caches, and a FIRST measure compensates on broken AND fixed.
  v.scrollDirection = null;
  v.resizeItem(idx, 250);

  // Now re-measure the SAME (already-cached) row +150 during an upward scroll — the skipped case.
  v.scrollDirection = 'backward';
  const offsetBefore = v.scrollOffset;
  adjustmentsPassed.length = 0;
  v.resizeItem(idx, 400);

  return { offsetDelta: v.scrollOffset - offsetBefore, adjustmentsPassed };
}

describe('compensateAboveViewportResize (Cause B)', () => {
  it('RED: virtual-core default does NOT compensate an above-viewport re-measure during upward scroll', () => {
    const broken = measureBackwardResize(false);
    expect(broken.offsetDelta).toBe(0);
    expect(broken.adjustmentsPassed).toEqual([]);
  });

  it('GREEN: the predicate compensates scrollOffset by the full size delta', () => {
    const fixed = measureBackwardResize(true);
    expect(fixed.offsetDelta).toBe(150);
    expect(fixed.adjustmentsPassed).toEqual([150]);
  });
});
