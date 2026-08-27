import { sideBySideRows } from '@dltech/atlas-core'
import { parseColor } from '@opentui/core'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { rowDigits, sideBySideColumns } from '../../../diff-layout'
import { theme } from '../../../theme'
import { DIVIDER_GLYPH } from '../diff-style'
import { SideBySideDiff } from '../side-by-side-diff'
import { FILE, GUARD, HUNK, NEW_CALL, OLD_CALL } from './fixtures'
import { cellsOfRow, CONTENT_LEFT, contentColumns, isColour, rowOf, shown } from './harness'

const ROWS = sideBySideRows(HUNK)

const WIDTH = 150

const COLUMNS = sideBySideColumns({
  width: contentColumns(WIDTH),
  digits: rowDigits({ rows: ROWS }),
})

const LEFT_WIDTH = COLUMNS.left.code + COLUMNS.left.numberGap + COLUMNS.left.numbers

const RIGHT_WIDTH = COLUMNS.right.numbers + COLUMNS.right.numberGap + COLUMNS.right.code

const DIVIDER_AT = CONTENT_LEFT + LEFT_WIDTH

const RIGHT_AT = DIVIDER_AT + COLUMNS.divider

const LEFT_GUTTER_AT = CONTENT_LEFT + COLUMNS.left.code + COLUMNS.left.numberGap

const at = (width: number) =>
  shown({
    node: <SideBySideDiff file={FILE} rows={[ROWS]} width={width} />,
    width,
  })

const spans = (args: {
  cells: ReturnType<typeof cellsOfRow>
  from: number
  count: number
  colour: string
}): boolean =>
  Array.from({ length: args.count }, (_unused, index) => index).every((index) =>
    isColour({ cell: args.cells[args.from + index], colour: args.colour }),
  )

describe('SideBySideDiff', () => {
  it('lands a removal and the addition that replaced it on one visual row', async () => {
    const { rows } = await at(WIDTH)
    expect(rowOf(rows, OLD_CALL)).toBe(rowOf(rows, 'withSecret'))
  }, 30_000)

  it('tints the left column for the removal and the right for the addition', async () => {
    const { rows, frame } = await at(WIDTH)
    const paired = cellsOfRow({ frame, row: rowOf(rows, OLD_CALL) })

    expect(
      spans({ cells: paired, from: CONTENT_LEFT, count: LEFT_WIDTH, colour: theme.diff.removeBg }),
    ).toBe(true)
    expect(
      spans({ cells: paired, from: RIGHT_AT, count: RIGHT_WIDTH, colour: theme.diff.addBg }),
    ).toBe(true)
  }, 30_000)

  it('leaves a context row untinted on both sides', async () => {
    const { rows, frame } = await at(WIDTH)
    const context = cellsOfRow({ frame, row: rowOf(rows, 'async validateUser') })

    expect(
      spans({ cells: context, from: CONTENT_LEFT, count: LEFT_WIDTH, colour: theme.panelBg }),
    ).toBe(true)
    expect(spans({ cells: context, from: RIGHT_AT, count: RIGHT_WIDTH, colour: theme.panelBg })).toBe(
      true,
    )
  }, 30_000)

  it('leaves the half with no counterpart bare rather than tinting it', async () => {
    const { rows, frame } = await at(WIDTH)
    const lonely = cellsOfRow({ frame, row: rowOf(rows, GUARD) })

    expect(
      spans({ cells: lonely, from: CONTENT_LEFT, count: LEFT_WIDTH, colour: theme.panelBg }),
    ).toBe(true)
    expect(
      spans({ cells: lonely, from: RIGHT_AT, count: RIGHT_WIDTH, colour: theme.diff.addBg }),
    ).toBe(true)
  }, 30_000)

  it('puts both gutters at the split, either side of a one-cell divider', async () => {
    const { rows, frame } = await at(WIDTH)
    const paired = rowOf(rows, OLD_CALL)

    expect(COLUMNS.divider).toBe(1)
    expect(rows[paired]?.[DIVIDER_AT]).toBe(DIVIDER_GLYPH)
    expect(cellsOfRow({ frame, row: paired })[DIVIDER_AT]?.fg.equals(parseColor(theme.rule))).toBe(
      true,
    )

    const left = rows[paired]?.slice(LEFT_GUTTER_AT, DIVIDER_AT) ?? ''
    const right = rows[paired]?.slice(RIGHT_AT, RIGHT_AT + COLUMNS.right.numbers) ?? ''
    expect(left).toBe('119')
    expect(right).toBe('119')
  }, 30_000)

  it('numbers only the side that holds the line', async () => {
    const { rows } = await at(WIDTH)
    const lonely = rowOf(rows, GUARD)
    expect(rows[lonely]?.slice(LEFT_GUTTER_AT, DIVIDER_AT)).toBe(' '.repeat(COLUMNS.left.numbers))
    expect(rows[lonely]?.slice(RIGHT_AT, RIGHT_AT + COLUMNS.right.numbers)).toBe('120')
  }, 30_000)

  it('never lets a row run past the width it was given', async () => {
    for (const width of [140, 160, 200]) {
      const { rows } = await at(width)
      for (const row of rows) expect(row.replace(/\s+$/, '').length).toBeLessThanOrEqual(width)
    }
  }, 60_000)

  it('says where the split holds, without naming a key nothing is listening for', async () => {
    const { rows } = await at(WIDTH)
    const footer = rows.find((row) => row.includes('falls back to inline')) ?? ''

    expect(footer).toContain('fits above 140 cols')
    expect(footer).not.toContain('s inline')
  }, 30_000)

  it('clips a long line on either side rather than wrapping it', async () => {
    const { rows } = await at(WIDTH)
    expect(rows[rowOf(rows, NEW_CALL.slice(0, 40))]).toContain('…')
  }, 30_000)
})
