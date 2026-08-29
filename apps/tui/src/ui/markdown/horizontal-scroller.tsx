import type { ScrollBoxRenderable } from '@opentui/core'
import React, { useCallback, useRef, useState } from 'react'

import { hideScrollbars } from '../hide-scrollbar'
import { PanBar } from './pan-bar'
import { useWheelAxis } from './wheel-axis'

export function HorizontalScroller(props: {
  rows: number
  columns: number
  width: number
  children: React.ReactNode
}): React.ReactNode {
  const scroller = useRef<ScrollBoxRenderable | null>(null)
  const [offset, setOffset] = useState(0)

  const handlePosition = useCallback((moved: { position: number }) => {
    setOffset(moved.position)
  }, [])

  /**
   * Every way the box can move — our own alt pan, the shift and horizontal-report panning it does
   * for itself, a drag that auto-scrolls — lands on the horizontal scrollbar's position, and this is
   * the only announcement of it: `ScrollBoxRenderable` emits nothing of its own, and it applies a
   * wheel report AFTER the listener on the box has run, so reading `scrollLeft` there is a frame late.
   */
  const handleScroller = useCallback(
    (box: ScrollBoxRenderable | null) => {
      scroller.current?.horizontalScrollBar.off('change', handlePosition)
      scroller.current = box
      if (!box) return
      hideScrollbars(box)
      box.horizontalScrollBar.on('change', handlePosition)
    },
    [handlePosition],
  )

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
    <box flexDirection="column" width={props.width} flexShrink={0}>
      <scrollbox
        ref={handleScroller}
        scrollX
        scrollY={false}
        flexShrink={0}
        height={props.rows}
        onMouseScroll={handleWheel}
      >
        {props.children}
      </scrollbox>
      <PanBar
        columns={props.columns}
        width={props.width}
        offset={offset}
        onSeek={(column) => {
          const box = scroller.current
          if (box) box.scrollLeft = column
        }}
      />
    </box>
  )
}
