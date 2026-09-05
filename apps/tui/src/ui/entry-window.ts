export const WINDOW_THRESHOLD = 200
export const WINDOW_MARGIN = 60
export const WINDOW_CAP = 160
export const FALLBACK_ROW_ESTIMATE = 8

export type Span = { start: number; end: number }

export function estimateRows(args: { measured: ReadonlyMap<string, number> }): number {
  if (args.measured.size === 0) return FALLBACK_ROW_ESTIMATE
  let sum = 0
  for (const rows of args.measured.values()) sum += rows
  return Math.max(1, Math.round(sum / args.measured.size))
}

export function rowsPerEntry(args: {
  keys: readonly string[]
  measured: ReadonlyMap<string, number>
  estimate: number
}): number[] {
  return args.keys.map((key) => args.measured.get(key) ?? args.estimate)
}

export function topsOf(args: { rows: readonly number[] }): number[] {
  const tops: number[] = []
  let top = 0
  for (const rows of args.rows) {
    tops.push(top)
    top += rows
  }
  return tops
}

function rowsAt(args: { rows: readonly number[]; index: number }): number {
  return args.rows[args.index] ?? 0
}

/** First and one-past-last entry whose rows intersect [scrollTop, scrollTop + viewportRows). */
export function visibleSpan(args: {
  tops: readonly number[]
  rows: readonly number[]
  scrollTop: number
  viewportRows: number
}): Span {
  const total = args.rows.length
  if (total === 0) return { start: 0, end: 0 }
  const bottom = args.scrollTop + Math.max(1, args.viewportRows)

  let start = 0
  while (start < total && (args.tops[start] ?? 0) + rowsAt({ rows: args.rows, index: start }) <= args.scrollTop) {
    start += 1
  }
  if (start >= total) return { start: total - 1, end: total }

  let end = start
  while (end < total && (args.tops[end] ?? 0) < bottom) end += 1
  return { start, end: Math.max(end, start + 1) }
}

/** The visible span widened by the margin and clamped to the cap, centered on the visible part. */
export function windowSpan(args: {
  visible: Span
  total: number
  margin: number
  cap: number
}): Span {
  if (args.total <= 0) return { start: 0, end: 0 }
  let start = Math.max(0, args.visible.start - args.margin)
  let end = Math.min(args.total, args.visible.end + args.margin)
  if (end - start <= args.cap) return { start, end }

  const visibleCount = args.visible.end - args.visible.start
  if (visibleCount >= args.cap) return { start: args.visible.start, end: args.visible.end }
  const extra = args.cap - visibleCount
  start = Math.max(0, args.visible.start - Math.floor(extra / 2))
  end = Math.min(args.total, start + args.cap)
  return { start: Math.max(0, end - args.cap), end }
}

/** Where the window opens: on the unseen divider when resuming, on the tail otherwise. */
export function initialSpan(args: {
  total: number
  anchorIndex: number
  margin: number
  cap: number
}): Span {
  if (args.anchorIndex >= 0 && args.anchorIndex < args.total) {
    return windowSpan({
      visible: { start: args.anchorIndex, end: args.anchorIndex + 1 },
      total: args.total,
      margin: args.margin,
      cap: args.cap,
    })
  }
  return { start: Math.max(0, args.total - args.cap), end: args.total }
}

/**
 * OpenTUI anchors a selection to the renderable under the press and re-derives its screen
 * position every frame, so a selection tracks its content only while that renderable stays
 * mounted. The pinned span is the entries an active selection covers; it mounts beside the
 * window rather than inside it, so scrolling far enough to move the window cannot unmount the
 * selection out from under the pointer.
 */
export function mountSpans(args: { base: Span; pinned: Span | null; total: number }): readonly Span[] {
  const { base, pinned, total } = args
  if (pinned === null) return [base]
  const start = Math.max(0, Math.min(pinned.start, total))
  const end = Math.max(start, Math.min(pinned.end, total))
  if (start === end) return [base]
  if (end < base.start) return [{ start, end }, base]
  if (start > base.end) return [base, { start, end }]
  return [{ start: Math.min(start, base.start), end: Math.max(end, base.end) }]
}

export type MountSection =
  | { readonly kind: 'spacer'; readonly height: number }
  | { readonly kind: 'entries'; readonly span: Span }

/** Index of the entry whose rows contain the given content row, clamped to the transcript. */
export function entryAtRow(args: {
  tops: readonly number[]
  rows: readonly number[]
  row: number
}): number | null {
  const total = args.rows.length
  if (total === 0) return null
  const clamped = Math.max(0, args.row)
  let index = 0
  while (
    index + 1 < total &&
    (args.tops[index] ?? 0) + rowsAt({ rows: args.rows, index }) <= clamped
  ) {
    index += 1
  }
  if ((args.tops[index] ?? 0) > clamped && index > 0) return index - 1
  return index
}

/** Spacer and entry sections covering the whole scroll extent, for ordered disjoint spans. */
export function sectionsOf(args: {
  tops: readonly number[]
  rows: readonly number[]
  spans: readonly Span[]
}): MountSection[] {
  const total = args.rows.length
  if (total === 0) return []
  const totalRows = (args.tops[total - 1] ?? 0) + rowsAt({ rows: args.rows, index: total - 1 })

  const sections: MountSection[] = []
  let covered = 0
  for (const span of args.spans) {
    const end = Math.min(span.end, total)
    if (span.start >= end) continue
    const top = args.tops[span.start] ?? totalRows
    if (top > covered) sections.push({ kind: 'spacer', height: top - covered })
    sections.push({ kind: 'entries', span: { start: span.start, end } })
    covered = Math.max(covered, (args.tops[end - 1] ?? 0) + rowsAt({ rows: args.rows, index: end - 1 }))
  }
  if (totalRows > covered) sections.push({ kind: 'spacer', height: totalRows - covered })
  return sections
}
