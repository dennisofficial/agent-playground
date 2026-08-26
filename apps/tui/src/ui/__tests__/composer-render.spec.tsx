import { describe, expect, it } from 'bun:test'
import React from 'react'

import { PANEL_BOTTOM_EDGE, PANEL_TOP_EDGE, RAIL, RAIL_HEAD, RAIL_TAIL } from '../borders'
import { Composer, composerTone, EComposerTone } from '../components/composer'
import { ComposerHints, type Hint } from '../components/composer-hints'
import { useDraft } from '../hooks/use-draft'
import { grammarsReady } from '../markdown/__tests__/harness'
import { frameOf } from './transcript-fixture'

await grammarsReady()

const WIDTH = 60

const PLACEHOLDER = 'Ask anything'

const LONG_DRAFT = 'wrap '.repeat(60)

function Draft(props: { text?: string; tone?: EComposerTone; maxRows?: number }): React.ReactNode {
  const draft = useDraft(props.text ?? '')
  return (
    <Composer
      draft={draft}
      width={WIDTH}
      placeholder={PLACEHOLDER}
      {...(props.tone === undefined ? {} : { tone: props.tone })}
      {...(props.maxRows === undefined ? {} : { maxRows: props.maxRows })}
    />
  )
}

describe('composerTone', () => {
  it('reads idle between turns', () => {
    expect(composerTone({ working: false, interrupting: false })).toBe(EComposerTone.Idle)
  })

  it('reads working while a turn runs', () => {
    expect(composerTone({ working: true, interrupting: false })).toBe(EComposerTone.Working)
  })

  it('lets interrupting outrank working', () => {
    expect(composerTone({ working: true, interrupting: true })).toBe(EComposerTone.Interrupting)
  })
})

describe('the composer', () => {
  it('marks the draft with a rail rather than a frame', async () => {
    const frame = await frameOf(<Draft />, WIDTH)
    expect(frame).toContain(`${RAIL}  ${PLACEHOLDER}`)
    for (const corner of ['╭', '╮', '╰', '╯']) expect(frame).not.toContain(corner)
  })

  it('runs the rail down every row a wrapped draft takes', async () => {
    const frame = await frameOf(<Draft text={LONG_DRAFT} />, WIDTH)
    const rows = frame.split('\n').filter((row) => row.startsWith(RAIL))
    expect(rows.length).toBeGreaterThan(1)
  })

  it('opens and closes the panel on a half row at both ends', async () => {
    const frame = await frameOf(<Draft />, WIDTH)
    const rows = frame.split('\n')
    expect(rows.find((row) => row.startsWith(RAIL_HEAD))).toContain(
      PANEL_TOP_EDGE.repeat(WIDTH - 1),
    )
    expect(rows.find((row) => row.startsWith(RAIL_TAIL))).toContain(
      PANEL_BOTTOM_EDGE.repeat(WIDTH - 1),
    )
  })

  it('sets the hidden-row count into the head band rather than taking a row', async () => {
    const frame = await frameOf(<Draft text={LONG_DRAFT} maxRows={2} />, WIDTH)
    const badge = frame.split('\n').find((row) => row.includes('more rows'))
    expect(badge).toStartWith(RAIL_HEAD)
    expect(badge).toContain(`${PANEL_TOP_EDGE} ⋯ 4 more rows ${PANEL_TOP_EDGE}`)
  })

  it('says nothing about hidden rows when the whole draft is showing', async () => {
    const frame = await frameOf(<Draft text="one row" />, WIDTH)
    expect(frame).not.toContain('more row')
  })
})

const HINTS: readonly Hint[] = [
  { key: '⏎', label: 'send' },
  { key: '⇧⏎', label: 'newline' },
  { key: 'ctrl+c', label: 'quit' },
]

describe('the composer hints', () => {
  it('leads with the status and pushes the hints to the right', async () => {
    const frame = await frameOf(
      <ComposerHints width={WIDTH} hints={HINTS} status="~/atlas · a-model" />,
      WIDTH,
    )
    const row = frame.split('\n').find((line) => line.includes('send'))
    expect(row?.trimStart()).toStartWith('~/atlas · a-model')
    expect(row?.trimEnd()).toEndWith('quit')
  })

  it('drops the status rather than colliding with the hints', async () => {
    const frame = await frameOf(
      <ComposerHints width={24} hints={HINTS} status="~/atlas · a-model" />,
      24,
    )
    expect(frame).not.toContain('a-model')
  })

  it('keeps the row to one line however narrow the terminal', async () => {
    const frame = await frameOf(<ComposerHints width={12} hints={HINTS} />, 12)
    const rows = frame.split('\n').filter((line) => line.trim().length > 0)
    expect(rows).toHaveLength(1)
  })
})
