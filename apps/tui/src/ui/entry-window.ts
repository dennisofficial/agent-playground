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

/** Spacer heights standing in for the unmounted entries above and below the span. */
export function spacerRows(args: {
  tops: readonly number[]
  rows: readonly number[]
  span: Span
}): { above: number; below: number } {
  const total = args.rows.length
  if (total === 0) return { above: 0, below: 0 }
  const above = args.tops[args.span.start] ?? 0
  const last = Math.min(args.span.end, total) - 1
  const mountedBottom = (args.tops[last] ?? 0) + rowsAt({ rows: args.rows, index: last })
  const totalRows = (args.tops[total - 1] ?? 0) + rowsAt({ rows: args.rows, index: total - 1 })
  return { above, below: Math.max(0, totalRows - mountedBottom) }
}
