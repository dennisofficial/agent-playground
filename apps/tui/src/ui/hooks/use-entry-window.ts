import type { Renderable, ScrollBoxRenderable } from '@opentui/core'
import { useRenderer } from '@opentui/react'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import {
  WINDOW_CAP,
  WINDOW_MARGIN,
  WINDOW_THRESHOLD,
  entryAtRow,
  estimateRows,
  initialSpan,
  mountSpans,
  rowsPerEntry,
  sectionsOf,
  topsOf,
  visibleSpan,
  windowSpan,
  type MountSection,
  type Span,
} from '../entry-window'

export type EntryWindow = {
  active: boolean
  sections: readonly MountSection[]
  handleTick: () => void
  offsetOfKey: (key: string) => number | null
}

const sameSpans = (left: readonly Span[], right: readonly Span[]): boolean =>
  left.length === right.length &&
  left.every((span, index) => span.start === right[index]?.start && span.end === right[index]?.end)

/**
 * OpenTUI's native handle pools cap at 2^14 per kind (TextBuffer, SyntaxStyle, renderable), and a
 * mounted transcript entry costs a dozen or more. Past a few hundred entries a resume throws
 * `Failed to create TextBuffer` mid-render and the tree unmounts before any boundary can paint.
 * Windowing mounts only the entries near the viewport; the rest stand in as measured-height
 * spacers so the scroll extent survives. Entries an active mouse selection covers stay mounted
 * beside the window, because OpenTUI re-derives a selection's screen position from the renderable
 * it started on and unmounting that renderable freezes the highlight mid-scroll.
 */
export function useEntryWindow(args: {
  entries: readonly { key: string }[]
  scroller: RefObject<ScrollBoxRenderable | null>
  anchorIndex: number
  width: number
}): EntryWindow {
  const renderer = useRenderer()
  const active = args.entries.length > WINDOW_THRESHOLD
  const measured = useRef(new Map<string, number>())
  const measuredAtWidth = useRef(args.width)
  const [version, setVersion] = useState(0)
  const [spans, setSpans] = useState<readonly Span[]>(() =>
    args.entries.length > WINDOW_THRESHOLD
      ? [
          initialSpan({
            total: args.entries.length,
            anchorIndex: args.anchorIndex,
            margin: WINDOW_MARGIN,
            cap: WINDOW_CAP,
          }),
        ]
      : [{ start: 0, end: Number.MAX_SAFE_INTEGER }],
  )

  const live = useRef({ active, entries: args.entries })
  live.current = { active, entries: args.entries }

  useEffect(() => {
    if (!live.current.active) return
    setSpans([
      initialSpan({
        total: args.entries.length,
        anchorIndex: args.anchorIndex,
        margin: WINDOW_MARGIN,
        cap: WINDOW_CAP,
      }),
    ])
  }, [active])

  useEffect(() => {
    if (measuredAtWidth.current === args.width) return
    measuredAtWidth.current = args.width
    measured.current.clear()
    setVersion((v) => v + 1)
  }, [args.width])

  const indexOfKey = useMemo(
    () => new Map(args.entries.map((entry, index) => [entry.key, index])),
    [args.entries],
  )
  const indexOfKeyLive = useRef(indexOfKey)
  indexOfKeyLive.current = indexOfKey

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
      if (!indexOfKeyLive.current.has(child.id)) continue
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

  const selectionPin = useCallback((): Span | null => {
    const box = args.scroller.current
    const selection = renderer.getSelection()
    if (box === null || selection === null || !selection.isActive) return null

    const indices = indexOfKeyLive.current
    let start = Number.MAX_SAFE_INTEGER
    let end = -1
    const pin = (index: number | undefined | null): void => {
      if (index === undefined || index === null) return
      start = Math.min(start, index)
      end = Math.max(end, index + 1)
    }

    for (const touched of selection.touchedRenderables) {
      if (touched.isDestroyed) continue
      let node: Renderable | null = touched
      while (node !== null && !indices.has(node.id)) node = node.parent
      pin(node === null ? null : indices.get(node.id))
    }

    for (const point of [selection.anchor, selection.focus]) {
      const { tops, rows } = layoutLive.current
      pin(entryAtRow({ tops, rows, row: point.y - box.viewport.y + box.scrollTop }))
    }

    return end < 0 ? null : { start, end }
  }, [renderer, args.scroller])

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
    const base = windowSpan({ visible, total: rows.length, margin: WINDOW_MARGIN, cap: WINDOW_CAP })
    const next = mountSpans({ base, pinned: selectionPin(), total: rows.length })
    setSpans((prev) => (sameSpans(prev, next) ? prev : next))
  }, [args.scroller, selectionPin])

  const offsetOfKey = useCallback(
    (key: string): number | null => {
      const index = live.current.entries.findIndex((entry) => entry.key === key)
      if (index < 0) return null
      return layoutLive.current.tops[index] ?? null
    },
    [],
  )

  const sections = useMemo(
    (): readonly MountSection[] =>
      active
        ? sectionsOf({ tops: layout.tops, rows: layout.rows, spans })
        : [{ kind: 'entries', span: { start: 0, end: args.entries.length } }],
    [active, layout, spans, args.entries.length],
  )

  return { active, sections, handleTick, offsetOfKey }
}
