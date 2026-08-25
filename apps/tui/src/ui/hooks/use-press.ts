import type { MouseEvent } from '@opentui/core'
import { useRenderer } from '@opentui/react'
import { useRef } from 'react'

export type PressHandlers = {
  onMouseDown?: (event: MouseEvent) => void
  onMouseDrag?: (event: MouseEvent) => void
  onMouseUp?: (event: MouseEvent) => void
}

/**
 * A click is press-and-release in one cell, never mouse-down: the renderer takes a text-selection
 * anchor on mouse-down before any handler runs, and `preventDefault()` is consulted only on the
 * path where no selection began. An anchor is stored relative to the renderable under the pointer,
 * so a reflow between press and release settles a drag the user never made.
 */
export function usePress(): (onPress?: () => void) => PressHandlers {
  const renderer = useRenderer()
  const origin = useRef<{ x: number; y: number } | null>(null)

  return (onPress) => {
    if (onPress === undefined) return {}
    return {
      onMouseDown: (event) => {
        origin.current = { x: event.x, y: event.y }
      },
      onMouseDrag: (event) => {
        const start = origin.current
        if (start && (start.x !== event.x || start.y !== event.y)) origin.current = null
      },
      onMouseUp: (event) => {
        const start = origin.current
        origin.current = null
        if (start === null || start.x !== event.x || start.y !== event.y) return
        event.stopPropagation()
        renderer.clearSelection()
        onPress()
      },
    }
  }
}
