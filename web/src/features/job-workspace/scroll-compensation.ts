import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";

/**
 * `shouldAdjustScrollPositionOnItemSizeChange` predicate for `useVirtualizer`.
 *
 * @tanstack/virtual-core deliberately SKIPS scroll-offset compensation when an
 * already-measured row above the viewport is re-measured while
 * `scrollDirection === 'backward'` (its `resizeItem` default). Async content —
 * a mermaid SVG landing at a slightly different height than its placeholder, or
 * a remounted row re-measuring with a small delta — triggers exactly this, so the
 * content in view slides down uncompensated: the transcript "pushes down" while the
 * user scrolls up.
 *
 * This compensates for ANY size change of a row above the viewport, regardless of
 * scroll direction or first-vs-re-measure — replicating the library's own
 * above-viewport coordinate test, minus the backward-scroll skip. The cast reaches
 * `getScrollOffset()`/`scrollAdjustments` (both private) to read the same coordinates
 * the library uses internally.
 */
export function compensateAboveViewportResize<
  TScrollElement extends Element | Window,
  TItemElement extends Element,
>(
  item: VirtualItem,
  _delta: number,
  instance: Virtualizer<TScrollElement, TItemElement>,
): boolean {
  const inst = instance as unknown as {
    getScrollOffset: () => number;
    scrollAdjustments: number;
  };
  return item.start < inst.getScrollOffset() + inst.scrollAdjustments;
}
