import React, { useRef } from 'react'

import { theme } from '../theme'

/**
 * The one horizontal scrollbar the transcript draws. Every overflowing block wears it — a fence that
 * pans its own text buffer, a table that rides a scrollbox — so the two mechanisms underneath do not
 * surface as two different bars.
 *
 * It is glyphs in a `<text>` rather than @opentui 0.4.5's own scrollbar because `SliderRenderable`
 * paints its cells at coordinates an ancestor's scissor rect does not reject. Nested inside the
 * transcript's scroller, a block scrolled out of view keeps its bar: the cells land on the clip's
 * top row instead of nowhere, and blend over whatever prose is drawn there.
 */
export function PanBar(props: {
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
      flexShrink={0}
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
