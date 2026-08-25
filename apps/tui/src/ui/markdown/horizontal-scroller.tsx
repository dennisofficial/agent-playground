import type { ScrollBoxRenderable } from '@opentui/core'
import React, { useRef } from 'react'

import { theme } from '../theme'
import { useWheelAxis } from './wheel-axis'

const SCROLLBAR_ROWS = 1

export function HorizontalScroller(props: {
  rows: number
  children: React.ReactNode
}): React.ReactNode {
  const scroller = useRef<ScrollBoxRenderable>(null)

  const handleWheel = useWheelAxis({
    canPan: () => {
      const box = scroller.current
      return box ? box.scrollWidth > box.viewport.width : false
    },
    pan: (sideways) => {
      const box = scroller.current
      // OpenTUI's scrollbox already pans itself for a horizontal report and for shift. Alt is the
      // only spelling it knows nothing about, and the only one some terminals deliver at all.
      if (!box || sideways.source !== 'alt') return
      box.scrollBy({ x: sideways.direction === 'left' ? -1 : 1, y: 0 })
    },
  })

  return (
    <scrollbox
      ref={scroller}
      scrollX
      scrollY={false}
      flexShrink={0}
      height={props.rows + SCROLLBAR_ROWS}
      onMouseScroll={handleWheel}
      horizontalScrollbarOptions={{
        showArrows: false,
        trackOptions: { foregroundColor: theme.dim },
      }}
    >
      {props.children}
    </scrollbox>
  )
}
