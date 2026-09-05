import { describe, expect, it } from 'bun:test'

import {
  FALLBACK_ROW_ESTIMATE,
  estimateRows,
  initialSpan,
  rowsPerEntry,
  spacerRows,
  topsOf,
  visibleSpan,
  windowSpan,
} from '../entry-window'

const layoutOf = (rows: readonly number[]) => ({ rows, tops: topsOf({ rows }) })

describe('estimateRows', () => {
  it('falls back before anything is measured', () => {
    expect(estimateRows({ measured: new Map() })).toBe(FALLBACK_ROW_ESTIMATE)
  })

  it('averages the measured heights', () => {
    const measured = new Map([
      ['a', 4],
      ['b', 12],
    ])
    expect(estimateRows({ measured })).toBe(8)
  })
})

describe('rowsPerEntry', () => {
  it('mixes measured heights with the estimate for unknown keys', () => {
    expect(
      rowsPerEntry({ keys: ['a', 'b', 'c'], measured: new Map([['b', 20]]), estimate: 5 }),
    ).toEqual([5, 20, 5])
  })
})

describe('visibleSpan', () => {
  const { rows, tops } = layoutOf([10, 10, 10, 10])

  it('is empty for an empty transcript', () => {
    expect(visibleSpan({ tops: [], rows: [], scrollTop: 0, viewportRows: 10 })).toEqual({
      start: 0,
      end: 0,
    })
  })

  it('covers exactly the entries intersecting the viewport', () => {
    expect(visibleSpan({ tops, rows, scrollTop: 0, viewportRows: 15 })).toEqual({ start: 0, end: 2 })
    expect(visibleSpan({ tops, rows, scrollTop: 10, viewportRows: 10 })).toEqual({ start: 1, end: 2 })
  })

  it('includes both entries when the viewport straddles a boundary', () => {
    expect(visibleSpan({ tops, rows, scrollTop: 5, viewportRows: 10 })).toEqual({ start: 0, end: 2 })
  })

  it('pins to the last entry when scrolled past the end', () => {
    expect(visibleSpan({ tops, rows, scrollTop: 999, viewportRows: 10 })).toEqual({ start: 3, end: 4 })
  })
})

describe('windowSpan', () => {
  it('widens the visible span by the margin on both sides', () => {
    expect(windowSpan({ visible: { start: 100, end: 110 }, total: 1000, margin: 60, cap: 160 })).toEqual({
      start: 40,
      end: 170,
    })
  })

  it('clamps to the transcript edges', () => {
    expect(windowSpan({ visible: { start: 0, end: 5 }, total: 1000, margin: 60, cap: 160 })).toEqual({
      start: 0,
      end: 65,
    })
    expect(windowSpan({ visible: { start: 990, end: 1000 }, total: 1000, margin: 60, cap: 160 })).toEqual({
      start: 930,
      end: 1000,
    })
  })

  it('caps the mounted count, centered on the visible span', () => {
    const span = windowSpan({ visible: { start: 500, end: 520 }, total: 1000, margin: 500, cap: 160 })
    expect(span.end - span.start).toBe(160)
    expect(span.start).toBeLessThanOrEqual(500)
    expect(span.end).toBeGreaterThanOrEqual(520)
  })

  it('never drops a visible span larger than the cap', () => {
    expect(windowSpan({ visible: { start: 10, end: 300 }, total: 1000, margin: 60, cap: 160 })).toEqual({
      start: 10,
      end: 300,
    })
  })
})

describe('initialSpan', () => {
  it('opens on the tail without an anchor', () => {
    expect(initialSpan({ total: 1000, anchorIndex: -1, margin: 60, cap: 160 })).toEqual({
      start: 840,
      end: 1000,
    })
  })

  it('opens around the anchor when resuming with unseen entries', () => {
    const span = initialSpan({ total: 1000, anchorIndex: 500, margin: 60, cap: 160 })
    expect(span.start).toBeLessThanOrEqual(500)
    expect(span.end).toBeGreaterThan(500)
  })

  it('ignores an anchor outside the transcript', () => {
    expect(initialSpan({ total: 10, anchorIndex: 50, margin: 60, cap: 160 })).toEqual({
      start: 0,
      end: 10,
    })
  })
})

describe('spacerRows', () => {
  it('stands in for the unmounted rows above and below the span', () => {
    const { rows, tops } = layoutOf([3, 5, 7, 11])
    expect(spacerRows({ tops, rows, span: { start: 1, end: 3 } })).toEqual({ above: 3, below: 11 })
  })

  it('is zero when everything is mounted', () => {
    const { rows, tops } = layoutOf([3, 5, 7])
    expect(spacerRows({ tops, rows, span: { start: 0, end: 3 } })).toEqual({ above: 0, below: 0 })
  })
})
