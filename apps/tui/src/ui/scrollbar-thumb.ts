import type { ScrollBoxRenderable, SliderRenderable } from '@opentui/core'
import { useCallback, type RefObject } from 'react'

/**
 * OpenTUI 0.4.5's SliderRenderable clamps `viewPortSize` to its own value range, and a scrollbar
 * passes the viewport in content units against a range of `content - viewport`. Content under twice
 * the viewport therefore draws a half-track thumb no matter how little there is to scroll, so a
 * transcript barely taller than the screen reads as a long one. Only the thumb geometry reads the
 * clamped field.
 */
export function relaxScrollbarThumb(box: ScrollBoxRenderable): void {
  liftViewportClamp(box.verticalScrollBar.slider)
  liftViewportClamp(box.horizontalScrollBar.slider)
}

type ClampedSlider = { _viewPortSize: number; requestRender: () => void }

function liftViewportClamp(slider: SliderRenderable): void {
  Object.defineProperty(slider, 'viewPortSize', {
    configurable: true,
    get(this: ClampedSlider): number {
      return this._viewPortSize
    },
    set(this: ClampedSlider, size: number) {
      const next = Math.max(0.01, size)
      if (next === this._viewPortSize) return
      this._viewPortSize = next
      this.requestRender()
    },
  })
}

export function useProportionalThumb(
  ref: RefObject<ScrollBoxRenderable | null>,
): (box: ScrollBoxRenderable | null) => void {
  return useCallback(
    (box: ScrollBoxRenderable | null) => {
      ref.current = box
      if (box) relaxScrollbarThumb(box)
    },
    [ref],
  )
}
