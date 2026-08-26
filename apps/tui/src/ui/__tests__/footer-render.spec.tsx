import { describe, expect, it } from 'bun:test'
import React from 'react'

import { Footer } from '../components/footer'
import { CONTEXT_BAR_CELLS, CONTEXT_BAR_GLYPH } from '../context-bar'
import { cellsOf } from '../hint-layout'
import { frameOf } from './transcript-fixture'

const MODEL = 'haiku-4-5'

const WIDTHS = [24, 40, 60, 80, 120, 200] as const

const footer = (props: {
  width: number
  percent?: number
  tokensLeft?: number
}): React.ReactNode => (
  <Footer
    width={props.width}
    model={MODEL}
    effort="medium"
    {...(props.percent === undefined
      ? {}
      : {
          context: {
            percent: props.percent,
            ...(props.tokensLeft === undefined ? {} : { tokensLeft: props.tokensLeft }),
          },
        })}
  />
)

const rowsOf = (frame: string): string[] =>
  frame
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => row.trim().length > 0)

describe('the footer', () => {
  it('never lets a row run past the terminal', async () => {
    for (const width of WIDTHS) {
      const frame = await frameOf(footer({ width, percent: 62, tokensLeft: 124_000 }), width)
      for (const row of frame.split('\n')) expect(cellsOf(row.trimEnd())).toBeLessThanOrEqual(width)
    }
  })

  it('reads as one row of model, effort and pressure', async () => {
    const frame = await frameOf(footer({ width: 140, percent: 62, tokensLeft: 124_000 }), 140)
    const rows = rowsOf(frame)
    expect(rows).toHaveLength(1)
    const row = rows[0] ?? ''
    expect(row.trimStart()).toStartWith(`${MODEL} · med · `)
    expect(row).toEndWith('124.0k left')
  })

  it('names no keyboard shortcut — `?` on an empty draft does that', async () => {
    const frame = await frameOf(footer({ width: 140, percent: 62 }), 140)
    expect(frame).not.toContain('send')
    expect(frame).not.toContain('ctrl+')
  })

  it('draws the meter as one unbroken run of cells', async () => {
    const frame = await frameOf(footer({ width: 120, percent: 62 }), 120)
    expect(frame).toContain(`${CONTEXT_BAR_GLYPH.repeat(CONTEXT_BAR_CELLS)} 62%`)
  })

  it('spells out the consequence once the window is under pressure', async () => {
    const frame = await frameOf(footer({ width: 100, percent: 86 }), 100)
    expect(frame).toContain('context 86% — compacts at 90')
  })

  it('keeps to one row with no meter at all when there is nothing to report', async () => {
    const frame = await frameOf(<Footer width={100} model={MODEL} />, 100)
    const rows = rowsOf(frame)
    expect(rows).toHaveLength(1)
    expect(frame).not.toContain(CONTEXT_BAR_GLYPH)
    expect(frame).not.toContain('%')
  })
})
