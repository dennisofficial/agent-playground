import { describe, expect, it } from 'bun:test'

import {
  FALLBACK_ROW_ESTIMATE,
  entryAtRow,
  estimateRows,
  initialSpan,
  mountSpans,
  rowsPerEntry,
  sectionsOf,
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

describe('mountSpans', () => {
  const base = { start: 100, end: 200 }

  it('is the base window alone without a selection', () => {
    expect(mountSpans({ base, pinned: null, total: 1000 })).toEqual([base])
  })

  it('keeps a pinned selection mounted beside the window', () => {
    expect(mountSpans({ base, pinned: { start: 900, end: 910 }, total: 1000 })).toEqual([
      base,
      { start: 900, end: 910 },
    ])
    expect(mountSpans({ base, pinned: { start: 10, end: 20 }, total: 1000 })).toEqual([
      { start: 10, end: 20 },
      base,
    ])
  })

  it('merges the pin into the window when they overlap or touch', () => {
    expect(mountSpans({ base, pinned: { start: 150, end: 250 }, total: 1000 })).toEqual([
      { start: 100, end: 250 },
    ])
    expect(mountSpans({ base, pinned: { start: 50, end: 100 }, total: 1000 })).toEqual([
      { start: 50, end: 200 },
    ])
    expect(mountSpans({ base, pinned: { start: 120, end: 130 }, total: 1000 })).toEqual([base])
  })

  it('clamps the pin to the transcript', () => {
    expect(mountSpans({ base, pinned: { start: 995, end: 1010 }, total: 1000 })).toEqual([
      base,
      { start: 995, end: 1000 },
    ])
  })
})

describe('entryAtRow', () => {
  const { rows, tops } = layoutOf([3, 5, 7, 11])

  it('finds the entry containing a content row', () => {
    expect(entryAtRow({ tops, rows, row: 0 })).toBe(0)
    expect(entryAtRow({ tops, rows, row: 3 })).toBe(1)
    expect(entryAtRow({ tops, rows, row: 7 })).toBe(1)
    expect(entryAtRow({ tops, rows, row: 8 })).toBe(2)
    expect(entryAtRow({ tops, rows, row: 25 })).toBe(3)
  })

  it('clamps past the ends instead of giving up', () => {
    expect(entryAtRow({ tops, rows, row: -5 })).toBe(0)
    expect(entryAtRow({ tops, rows, row: 999 })).toBe(3)
  })

  it('is null for an empty transcript', () => {
    expect(entryAtRow({ tops: [], rows: [], row: 4 })).toBeNull()
  })
})

describe('sectionsOf', () => {
  it('stands spacers in for the unmounted rows around one span', () => {
    const { rows, tops } = layoutOf([3, 5, 7, 11])
    expect(sectionsOf({ tops, rows, spans: [{ start: 1, end: 3 }] })).toEqual([
      { kind: 'spacer', height: 3 },
      { kind: 'entries', span: { start: 1, end: 3 } },
      { kind: 'spacer', height: 11 },
    ])
  })

  it('bridges disjoint spans with a spacer for the gap', () => {
    const { rows, tops } = layoutOf([3, 5, 7, 11])
    expect(
      sectionsOf({ tops, rows, spans: [{ start: 0, end: 1 }, { start: 3, end: 4 }] }),
    ).toEqual([
      { kind: 'entries', span: { start: 0, end: 1 } },
      { kind: 'spacer', height: 12 },
      { kind: 'entries', span: { start: 3, end: 4 } },
    ])
  })

  it('has no spacers when everything is mounted', () => {
    const { rows, tops } = layoutOf([3, 5, 7])
    expect(sectionsOf({ tops, rows, spans: [{ start: 0, end: 3 }] })).toEqual([
      { kind: 'entries', span: { start: 0, end: 3 } },
    ])
  })

  it('is empty for an empty transcript', () => {
    expect(sectionsOf({ tops: [], rows: [], spans: [] })).toEqual([])
  })
})
