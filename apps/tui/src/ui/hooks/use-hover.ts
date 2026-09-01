import type { MouseEvent } from '@opentui/core'
import { useCallback, useState } from 'react'

export type HoverHandlers = {
  onMouseOver?: (event: MouseEvent) => void
  onMouseOut?: (event: MouseEvent) => void
}

export type Hovering = {
  hovered: string | null
  handlersFor: (key: string | undefined) => HoverHandlers
}

/**
 * The pointer is over one row at a time, so the whole list needs a single name rather than a flag
 * per row. `onMouseOut` clears only the row it names: the enter of the row below arrives before the
 * leave of the row above, and clearing unconditionally would drop the pointer the list just gained.
 */
export function useHover(): Hovering {
  const [hovered, setHovered] = useState<string | null>(null)

  const handlersFor = useCallback((key: string | undefined): HoverHandlers => {
    if (key === undefined) return {}

    return {
      onMouseOver: () => setHovered(key),
      onMouseOut: () => setHovered((current) => (current === key ? null : current)),
    }
  }, [])

  return { hovered, handlersFor }
}
