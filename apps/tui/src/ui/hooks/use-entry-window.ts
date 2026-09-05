import type { ScrollBoxRenderable } from '@opentui/core'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import {
  WINDOW_CAP,
  WINDOW_MARGIN,
  WINDOW_THRESHOLD,
  estimateRows,
  initialSpan,
  rowsPerEntry,
  spacerRows,
  topsOf,
  visibleSpan,
  windowSpan,
  type Span,
} from '../entry-window'

export type EntryWindow = {
  active: boolean
  span: Span
  above: number
  below: number
  handleTick: () => void
  offsetOfKey: (key: string) => number | null
}

const EVERYTHING: Span = { start: 0, end: Number.MAX_SAFE_INTEGER }

/**
 * OpenTUI's native handle pools cap at 2^14 per kind (TextBuffer, SyntaxStyle, renderable), and a
 * mounted transcript entry costs a dozen or more. Past a few hundred entries a resume throws
 * `Failed to create TextBuffer` mid-render and the tree unmounts before any boundary can paint.
 * Windowing mounts only the entries near the viewport; the rest stand in as measured-height
 * spacers so the scroll extent survives.
 */
export function useEntryWindow(args: {
  entries: readonly { key: string }[]
  scroller: RefObject<ScrollBoxRenderable | null>
  anchorIndex: number
  width: number
}): EntryWindow {
  const active = args.entries.length > WINDOW_THRESHOLD
  const measured = useRef(new Map<string, number>())
  const measuredAtWidth = useRef(args.width)
  const [version, setVersion] = useState(0)
  const [span, setSpan] = useState<Span>(() =>
    args.entries.length > WINDOW_THRESHOLD
      ? initialSpan({
          total: args.entries.length,
          anchorIndex: args.anchorIndex,
          margin: WINDOW_MARGIN,
          cap: WINDOW_CAP,
        })
      : EVERYTHING,
  )

  const live = useRef({ active, entries: args.entries })
  live.current = { active, entries: args.entries }

  useEffect(() => {
    if (!live.current.active) return
    setSpan(
      initialSpan({
        total: args.entries.length,
        anchorIndex: args.anchorIndex,
        margin: WINDOW_MARGIN,
        cap: WINDOW_CAP,
      }),
    )
  }, [active])

  useEffect(() => {
    if (measuredAtWidth.current === args.width) return
    measuredAtWidth.current = args.width
    measured.current.clear()
    setVersion((v) => v + 1)
  }, [args.width])

  const knownKeys = useMemo(() => new Set(args.entries.map((entry) => entry.key)), [args.entries])

  const layout = useMemo(() => {
    const rows = rowsPerEntry({
      keys: args.entries.map((entry) => entry.key),
      measured: measured.current,
      estimate: estimateRows({ measured: measured.current }),
    })
    return { rows, tops: topsOf({ rows }) }
  }, [args.entries, version])
  const layoutLive = useRef(layout)
  layoutLive.current = layout

  useEffect(() => {
    if (!active) return
    const box = args.scroller.current
    if (!box) return

    let changed = false
    let unlaid = false
    for (const child of box.content.getChildren()) {
      if (!knownKeys.has(child.id)) continue
      if (child.height === 0) {
        unlaid = true
        continue
      }
      if (measured.current.get(child.id) === child.height) continue
      measured.current.set(child.id, child.height)
      changed = true
    }
    if (changed) setVersion((v) => v + 1)
    if (unlaid) {
      const retry = setTimeout(() => setVersion((v) => v + 1), 0)
      return () => clearTimeout(retry)
    }
  })

  const handleTick = useCallback(() => {
    if (!live.current.active) return
    const box = args.scroller.current
    if (!box) return
    const { rows, tops } = layoutLive.current
    const visible = visibleSpan({
      tops,
      rows,
      scrollTop: box.scrollTop,
      viewportRows: box.viewport.height,
    })
    const next = windowSpan({ visible, total: rows.length, margin: WINDOW_MARGIN, cap: WINDOW_CAP })
    setSpan((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [args.scroller])

  const offsetOfKey = useCallback(
    (key: string): number | null => {
      const index = live.current.entries.findIndex((entry) => entry.key === key)
      if (index < 0) return null
      return layoutLive.current.tops[index] ?? null
    },
    [],
  )

  const effective = active ? span : { start: 0, end: args.entries.length }
  const { above, below } = active
    ? spacerRows({ tops: layout.tops, rows: layout.rows, span: effective })
    : { above: 0, below: 0 }

  return { active, span: effective, above, below, handleTick, offsetOfKey }
}
