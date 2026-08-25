import type { Renderable } from '@opentui/core'
import React, { useRef, useState } from 'react'

import { theme } from '../theme'
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
      <ScrollBar
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

function ScrollBar(props: {
  columns: number
  width: number
  offset: number
  onSeek: (column: number) => void
}): React.ReactNode {
  const bar = useRef<{ x: number } | null>(null)
  const grabbedAt = useRef<number | null>(null)
  const thumb = Math.max(
    1,
    Math.min(props.width, Math.round((props.width * props.width) / props.columns)),
  )
  const travel = props.width - thumb
  const span = Math.max(1, props.columns - props.width)
  const before = Math.max(0, Math.min(travel, Math.round((props.offset / span) * travel)))

  const seekTo = (args: { screenX: number; offsetInThumb: number }): void => {
    const local = args.screenX - (bar.current?.x ?? 0)
    const placed = Math.max(0, Math.min(travel, local - args.offsetInThumb))
    props.onSeek(travel === 0 ? 0 : Math.round((placed / travel) * span))
  }

  return (
    <box
      ref={bar as never}
      flexDirection="row"
      width={props.width}
      height={1}
      onMouseDown={(event) => {
        event.stopPropagation()
        event.preventDefault()
        const local = event.x - (bar.current?.x ?? 0)
        const onThumb = local >= before && local < before + thumb
        grabbedAt.current = onThumb ? local - before : Math.floor(thumb / 2)
        seekTo({ screenX: event.x, offsetInThumb: grabbedAt.current })
      }}
      onMouseDrag={(event) => {
        if (grabbedAt.current === null) return
        event.stopPropagation()
        seekTo({ screenX: event.x, offsetInThumb: grabbedAt.current })
      }}
      onMouseUp={() => {
        grabbedAt.current = null
      }}
    >
      {before > 0 ? (
        <text fg={theme.dim} selectable={false}>
          {'─'.repeat(before)}
        </text>
      ) : null}
      <text selectable={false}>{'━'.repeat(thumb)}</text>
      {travel - before > 0 ? (
        <text fg={theme.dim} selectable={false}>
          {'─'.repeat(travel - before)}
        </text>
      ) : null}
    </box>
  )
}
