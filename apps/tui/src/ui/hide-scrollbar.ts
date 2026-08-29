import type { ScrollBoxRenderable } from '@opentui/core'
import { useCallback, type RefObject } from 'react'

export function hideVerticalScrollbar(box: ScrollBoxRenderable): void {
  box.verticalScrollBar.visible = false
}

export function hideScrollbars(box: ScrollBoxRenderable): void {
  hideVerticalScrollbar(box)
  box.horizontalScrollBar.visible = false
}

export function useHiddenVerticalScrollbar(
  ref: RefObject<ScrollBoxRenderable | null>,
): (box: ScrollBoxRenderable | null) => void {
  return useCallback(
    (box: ScrollBoxRenderable | null) => {
      ref.current = box
      if (box) hideVerticalScrollbar(box)
    },
    [ref],
  )
}
