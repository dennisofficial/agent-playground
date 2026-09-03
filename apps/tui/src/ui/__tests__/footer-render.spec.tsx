import { describe, expect, it } from 'bun:test'
import React from 'react'

import { EEffort, EMeterBand } from '@dltech/atlas-core'

import { Footer } from '../components/footer'
import { cellsOf } from '../hint-layout'
import { frameOf } from './transcript-fixture'

const MODEL = 'haiku-4-5'

const WIDTHS = [24, 40, 60, 80, 120, 200] as const

const METERS = [
  { label: '5h', band: EMeterBand.Normal, text: '34%' },
  { label: 'wk', band: EMeterBand.Spent, text: '2h14m' },
] as const

const footer = (props: {
  width: number
  percent?: number
  tokensUsed?: number
  meters?: readonly { label: string; band: EMeterBand; text: string }[]
}): React.ReactNode => (
  <Footer
    width={props.width}
    model={MODEL}
    effort={EEffort.Medium}
    {...(props.percent === undefined
      ? {}
      : {
          context: {
            percent: props.percent,
            ...(props.tokensUsed === undefined ? {} : { tokensUsed: props.tokensUsed }),
            ...(props.meters === undefined ? {} : { meters: props.meters }),
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
      const frame = await frameOf(footer({ width, percent: 62, tokensUsed: 124_000 }), width)
      for (const row of frame.split('\n')) expect(cellsOf(row.trimEnd())).toBeLessThanOrEqual(width)
    }
  })

  it('keeps what is answering on the left and what it is spending on the right', async () => {
    const frame = await frameOf(footer({ width: 140, percent: 62, tokensUsed: 124_000 }), 140)
    const rows = rowsOf(frame)
    expect(rows).toHaveLength(1)
    const row = rows[0] ?? ''
    expect(row.trimStart()).toStartWith(`${MODEL} med`)
    expect(row).toEndWith('124.0k 62%')
    expect(row).toContain('   ')
  })

  it('pushes the read-out to the far edge rather than trailing the model', async () => {
    const width = 140
    const frame = await frameOf(footer({ width, percent: 62, tokensUsed: 124_000 }), width)
    const row = rowsOf(frame)[0] ?? ''
    expect(cellsOf(row)).toBe(width - 3)
  })

  it('reports the account windows alongside the context one', async () => {
    const frame = await frameOf(
      footer({ width: 160, percent: 62, tokensUsed: 124_000, meters: METERS }),
      160,
    )
    const row = rowsOf(frame)[0] ?? ''
    expect(row).toContain('124.0k')
    expect(row).toContain('5h 34%')
    expect(row).toEndWith('wk 2h14m')
  })

  it('names no keyboard shortcut — `?` on an empty draft does that', async () => {
    const frame = await frameOf(footer({ width: 140, percent: 62 }), 140)
    expect(frame).not.toContain('send')
    expect(frame).not.toContain('ctrl+')
  })

  it('draws no gauge — the figures carry the reading now', async () => {
    const frame = await frameOf(footer({ width: 120, percent: 62, tokensUsed: 124_000 }), 120)
    expect(frame).not.toContain('█')
    expect(frame).toContain('124.0k 62%')
  })

  it('spells out the consequence once the window is under pressure', async () => {
    const frame = await frameOf(footer({ width: 100, percent: 86 }), 100)
    expect(frame).toContain('context 86% — /compact to compact')
  })

  it('keeps to one row with no meter at all when there is nothing to report', async () => {
    const frame = await frameOf(<Footer width={100} model={MODEL} />, 100)
    const rows = rowsOf(frame)
    expect(rows).toHaveLength(1)
    expect(frame).not.toContain('█')
    expect(frame).not.toContain('%')
  })
})
