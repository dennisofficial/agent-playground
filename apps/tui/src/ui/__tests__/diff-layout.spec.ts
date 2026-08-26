import { EDiffLine, type DiffHunk, type DiffRow } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import {
  diffMode,
  EDiffMode,
  hunkExtent,
  hunkMarker,
  inlineColumns,
  inlineWidth,
  MIN_NUMBER_COLUMNS,
  numberDigits,
  rowDigits,
  sideBySideColumns,
  sideBySideWidth,
} from '../diff-layout'
import { SIDE_BY_SIDE_MIN_TERMINAL_WIDTH } from '../theme'

const WIDTHS = Array.from({ length: 201 }, (_unused, index) => index + 40)

const NARROW = Array.from({ length: 40 }, (_unused, index) => index)

const DIGITS = [1, 2, 3, 5, 9]

describe('diffMode', () => {
  it('flips exactly at the threshold, not one column either side of it', () => {
    expect(diffMode({ width: SIDE_BY_SIDE_MIN_TERMINAL_WIDTH - 1 })).toBe(EDiffMode.Inline)
    expect(diffMode({ width: SIDE_BY_SIDE_MIN_TERMINAL_WIDTH })).toBe(EDiffMode.SideBySide)
    expect(diffMode({ width: SIDE_BY_SIDE_MIN_TERMINAL_WIDTH + 1 })).toBe(EDiffMode.SideBySide)
  })
})

describe('inlineColumns', () => {
  it('spends the width exactly, at every width and every gutter size', () => {
    for (const width of WIDTHS) {
      for (const digits of DIGITS) {
        expect(inlineWidth(inlineColumns({ width, digits }))).toBe(width)
      }
    }
  })

  it('still spends it exactly when the row is absurdly narrow', () => {
    for (const width of NARROW) {
      for (const digits of DIGITS) {
        const columns = inlineColumns({ width, digits })
        expect(inlineWidth(columns)).toBe(width)
        expect(columns.code).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('gives the gutter the room it asked for once there is any to spare', () => {
    const columns = inlineColumns({ width: 80, digits: 3 })
    expect(columns).toEqual({ numbers: 3, numberGap: 1, sign: 1, signGap: 1, code: 74 })
  })
})

describe('sideBySideColumns', () => {
  it('spends the width exactly, divider included, at every width', () => {
    for (const width of WIDTHS) {
      for (const digits of DIGITS) {
        expect(sideBySideWidth(sideBySideColumns({ width, digits }))).toBe(width)
      }
    }
  })

  it('never goes negative on the code band when the split leaves nothing', () => {
    for (const width of NARROW) {
      const columns = sideBySideColumns({ width, digits: 4 })
      expect(sideBySideWidth(columns)).toBe(width)
      expect(columns.left.code).toBeGreaterThanOrEqual(0)
      expect(columns.right.code).toBeGreaterThanOrEqual(0)
    }
  })

  it('splits the leftover cell to the left column rather than dropping it', () => {
    const columns = sideBySideColumns({ width: 140, digits: 3 })
    expect(columns.divider).toBe(1)
    expect(columns.left.code + columns.left.numberGap + columns.left.numbers).toBe(70)
    expect(columns.right.code + columns.right.numberGap + columns.right.numbers).toBe(69)
  })
})

describe('numberDigits', () => {
  it('sizes the gutter to the highest number either side holds', () => {
    expect(
      numberDigits({
        lines: [
          { kind: EDiffLine.Context, oldNumber: 9, newNumber: 9, text: '' },
          { kind: EDiffLine.Added, oldNumber: null, newNumber: 1204, text: '' },
        ],
      }),
    ).toBe(4)
  })

  it('never shrinks below the floor, so a short file does not jitter', () => {
    expect(numberDigits({ lines: [] })).toBe(MIN_NUMBER_COLUMNS)
    expect(
      numberDigits({ lines: [{ kind: EDiffLine.Elision, oldNumber: null, newNumber: null, text: '' }] }),
    ).toBe(MIN_NUMBER_COLUMNS)
  })

  it('reads both halves of a paired row', () => {
    const rows: DiffRow[] = [
      { left: { kind: EDiffLine.Removed, oldNumber: 12, newNumber: null, text: '' }, right: null },
      { left: null, right: { kind: EDiffLine.Added, oldNumber: null, newNumber: 34567, text: '' } },
    ]
    expect(rowDigits({ rows })).toBe(5)
  })
})

describe('hunkExtent', () => {
  const hunk: DiffHunk = {
    heading: 'AuthService.validateUser',
    oldStart: 118,
    newStart: 118,
    lines: [
      { kind: EDiffLine.Context, oldNumber: 118, newNumber: 118, text: 'a' },
      { kind: EDiffLine.Removed, oldNumber: 119, newNumber: null, text: 'b' },
      { kind: EDiffLine.Added, oldNumber: null, newNumber: 119, text: 'c' },
      { kind: EDiffLine.Added, oldNumber: null, newNumber: 120, text: 'd' },
      { kind: EDiffLine.Elision, oldNumber: null, newNumber: null, text: '', elided: 9 },
    ],
  }

  it('counts the lines a collapsed elision still stands for on both sides', () => {
    expect(hunkExtent({ hunk })).toEqual({
      oldStart: 118,
      oldCount: 11,
      newStart: 118,
      newCount: 12,
    })
  })

  it('spells the marker the way git does', () => {
    expect(hunkMarker({ hunk })).toBe('@@ -118,11 +118,12 @@')
  })
})
