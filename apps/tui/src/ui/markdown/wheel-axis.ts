import type { MouseEvent } from '@opentui/core'
import { useRef } from 'react'

const AXIS_LOCK_MS = 300

export type Sideways = {
  direction: 'left' | 'right'
  source: 'wheel' | 'shift' | 'alt'
}

export function useWheelAxis(opts: {
  canPan: () => boolean
  pan: (sideways: Sideways, event: MouseEvent) => void
}): (event: MouseEvent) => void {
  const pannedAt = useRef(0)

  return (event: MouseEvent): void => {
    if (!opts.canPan()) return

    const sideways = readSideways(event)
    if (sideways) {
      pannedAt.current = Date.now()
      opts.pan(sideways, event)
      event.stopPropagation()
      return
    }

    if (Date.now() - pannedAt.current < AXIS_LOCK_MS) event.stopPropagation()
  }
}

function readSideways(event: MouseEvent): Sideways | null {
  const wheel = event.scroll?.direction
  // macOS rewrites shift+wheel as a horizontal report before the terminal sees it, so this branch
  // has to win over the modifier branches below or a trackpad swipe matches nothing.
  if (wheel === 'left' || wheel === 'right') return { direction: wheel, source: 'wheel' }
  if (wheel !== 'up' && wheel !== 'down') return null

  // Inverted against OpenTUI's own shift mapping: the viewport chases the wheel, so scrolling down
  // walks towards the block's start the way scrolling down a page walks towards its end.
  const direction = wheel === 'up' ? 'right' : 'left'
  if (event.modifiers.alt) return { direction, source: 'alt' }
  if (event.modifiers.shift) return { direction, source: 'shift' }
  return null
}
