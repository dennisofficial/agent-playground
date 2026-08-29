import type { Renderable } from '@opentui/core'
import React, { useRef, useState } from 'react'

import { PanBar } from './pan-bar'
import { useWheelAxis } from './wheel-axis'

type Pannable = Renderable & { scrollX: number; maxScrollX: number }

export function TextPanner(props: {
  columns: number
  width: number
  rows: number
  children: React.ReactElement
}): React.ReactNode {
  const child = useRef<Pannable | null>(null)
  const [offset, setOffset] = useState(0)

  const handleWheel = useWheelAxis({
    canPan: () => (child.current?.maxScrollX ?? 0) > 0,
    pan: (sideways, event) => {
      const node = child.current
      if (!node) return
      // `TextBufferRenderable` maps a horizontal report onto its own `scrollX` before this listener
      // runs, so re-applying that one spelling would move the block twice per report.
      const alreadyMoved = sideways.source === 'wheel' && event.target === node
      if (!alreadyMoved) node.scrollX += sideways.direction === 'left' ? -1 : 1
      setOffset(node.scrollX)
    },
  })

  return (
    <box
      flexDirection="column"
      width={props.width}
      height={props.rows + 1}
      flexShrink={0}
      onMouseScroll={handleWheel}
    >
      {React.cloneElement(props.children, { ref: child } as Partial<unknown>)}
      <PanBar
        columns={props.columns}
        width={props.width}
        offset={offset}
        onSeek={(column) => {
          const node = child.current
          if (!node) return
          node.scrollX = column
          setOffset(node.scrollX)
        }}
      />
    </box>
  )
}
