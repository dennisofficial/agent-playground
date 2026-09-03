import { parseColor } from '@opentui/core'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { RAIL_TAIL } from '../../../borders'
import { inlineColumns, numberDigits } from '../../../diff-layout'
import { theme } from '../../../theme'
import { InlineDiff } from '../inline-diff'
import { ELIDED, emphasiseNewCall, EMPHASIS_END, EMPHASIS_START, FILE, HUNK, NEW_CALL, OLD_CALL, WIDE_FILE } from './fixtures'
import { cellsOfRow, CONTENT_LEFT, contentColumns, isColour, rowOf, shown } from './harness'

const WIDTHS = [60, 80, 100, 200] as const

const SEAM = 1

const DIGITS = numberDigits({ lines: HUNK.lines })

const COLUMNS = inlineColumns({ width: contentColumns(90), digits: DIGITS })

const SIGN_AT = CONTENT_LEFT + COLUMNS.numbers + COLUMNS.numberGap

const CODE_AT = SIGN_AT + COLUMNS.sign + COLUMNS.signGap

const at = (width: number) => shown({ node: <InlineDiff file={FILE} width={width} />, width })

describe('InlineDiff', () => {
  it('spends one row per line and none on a hunk heading, at every width', async () => {
    for (const width of WIDTHS) {
      const { rows } = await at(width)
      const header = rowOf(rows, 'auth.service.ts')
      const tail = rows.findIndex((row) => row.startsWith(RAIL_TAIL))
      expect(tail - header - 1).toBe(SEAM + HUNK.lines.length)
    }
  }, 60_000)

  it('never lets a row run past the width it was given', async () => {
    for (const width of WIDTHS) {
      const { rows } = await at(width)
      for (const row of rows) expect(row.replace(/\s+$/, '').length).toBeLessThanOrEqual(width)
    }
  }, 60_000)

  it('still mounts where there is barely room for the gutter', async () => {
    for (const width of [8, 12, 20, 40]) {
      const { rows } = await at(width)
      expect(rows.some((row) => row.startsWith(RAIL_TAIL))).toBe(true)
      for (const row of rows) expect(row.replace(/\s+$/, '').length).toBeLessThanOrEqual(width)
    }
  }, 60_000)

  it('tints the whole row rather than only the cells the code reaches', async () => {
    const { rows, frame } = await at(90)
    const columns = contentColumns(90)

    const tinted = (args: { row: number; colour: string }): boolean => {
      const cells = cellsOfRow({ frame, row: args.row })
      return Array.from({ length: columns }, (_unused, index) => index).every((index) =>
        isColour({ cell: cells[CONTENT_LEFT + index], colour: args.colour }),
      )
    }

    expect(tinted({ row: rowOf(rows, NEW_CALL), colour: theme.diff.addBg })).toBe(true)
    expect(tinted({ row: rowOf(rows, OLD_CALL), colour: theme.diff.removeBg })).toBe(true)
    expect(tinted({ row: rowOf(rows, 'unchanged lines'), colour: theme.diff.bandBg })).toBe(true)
    expect(tinted({ row: rowOf(rows, 'async validateUser'), colour: theme.panelBg })).toBe(true)
  }, 30_000)

  it('signs a removal with U+2212 in a single cell, never a hyphen', async () => {
    const { rows } = await at(90)
    expect(COLUMNS.sign).toBe(1)
    expect(rows[rowOf(rows, OLD_CALL)]?.[SIGN_AT]).toBe('−')
    expect(rows[rowOf(rows, NEW_CALL)]?.[SIGN_AT]).toBe('+')
    expect(rows[rowOf(rows, 'async validateUser')]?.[SIGN_AT]).toBe(' ')
    expect(rows[rowOf(rows, OLD_CALL)]?.[SIGN_AT]).not.toBe('-')
  }, 30_000)

  it('says exactly how many lines an elision stands for', async () => {
    const { rows } = await at(90)
    const row = rows[rowOf(rows, 'unchanged lines')] ?? ''
    expect(row).toContain(`${ELIDED} unchanged lines`)
    expect(row.slice(CONTENT_LEFT, CONTENT_LEFT + DIGITS)).toBe('⋯'.padStart(DIGITS))
  }, 30_000)

  it('right-aligns the gutter and numbers a mixed hunk from the side that has one', async () => {
    const { rows } = await at(90)
    const first = rowOf(rows, 'async validateUser')
    const gutter = HUNK.lines.map(
      (_unused, index) => rows[first + index]?.slice(CONTENT_LEFT, CONTENT_LEFT + DIGITS) ?? '',
    )
    expect(gutter).toEqual(['118', '119', '119', '120', '121', '  ⋯', '131'])
  }, 30_000)

  it('clips a line too wide for the band instead of wrapping it onto the next row', async () => {
    const { rows } = await shown({ node: <InlineDiff file={WIDE_FILE} width={80} />, width: 80 })
    const wide = rowOf(rows, 'const banner')
    expect(rows[wide]).toContain('…')
    expect(rows[wide + 1]).toContain('  }')
  }, 30_000)

  it('keeps a keyword its own colour where the row is tinted', async () => {
    const { rows, frame } = await at(90)
    const row = rowOf(rows, NEW_CALL)
    const column = rows[row]?.indexOf('const') ?? -1
    expect(column).toBeGreaterThan(0)

    const cell = cellsOfRow({ frame, row })[column]
    expect(cell?.char).toBe('c')
    expect(cell?.bg.equals(parseColor(theme.diff.addBg))).toBe(true)
    expect(cell?.fg.equals(parseColor(theme.body))).toBe(false)
  }, 30_000)

  it('lifts only the changed span onto the word tint', async () => {
    const { rows, frame } = await shown({
      node: <InlineDiff file={FILE} width={90} emphasis={emphasiseNewCall} />,
      width: 90,
    })
    const cells = cellsOfRow({ frame, row: rowOf(rows, NEW_CALL) })

    expect(isColour({ cell: cells[CODE_AT + EMPHASIS_START], colour: theme.diff.wordBg })).toBe(true)
    expect(isColour({ cell: cells[CODE_AT + EMPHASIS_END - 1], colour: theme.diff.wordBg })).toBe(
      true,
    )
    expect(isColour({ cell: cells[CODE_AT + EMPHASIS_START - 1], colour: theme.diff.addBg })).toBe(
      true,
    )
    expect(isColour({ cell: cells[CODE_AT + EMPHASIS_END], colour: theme.diff.addBg })).toBe(true)
  }, 30_000)

  it('counts the files under review, and names no key that nothing is listening for', async () => {
    const { rows } = await shown({
      node: <InlineDiff file={FILE} width={90} files={{ index: 1, total: 3 }} />,
      width: 90,
    })
    const footer = rows.find((row) => row.includes('1/3 files')) ?? ''

    expect(footer).toContain('1/3 files')
    for (const phantom of ['a apply', 'r reject', 's side-by-side', 'n next']) {
      expect(footer).not.toContain(phantom)
    }
  }, 30_000)

  it('heads the panel with the path and the counts', async () => {
    const { rows } = await at(90)
    const header = rows[rowOf(rows, 'auth.service.ts')] ?? ''
    expect(header).toContain('src/auth/auth.service.ts')
    expect(header).toContain('+34')
    expect(header).toContain('−7')
    expect(rows.some((row) => row.includes('@@'))).toBe(false)
  }, 30_000)
})
