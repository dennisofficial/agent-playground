import { describe, expect, it } from 'bun:test'
import React from 'react'

import { EEffort, EModelVendor, type ModelEntry } from '@dltech/atlas-core'

import { EFFORT_ABBREVIATION, Switcher } from '../components/switcher'
import { cellsOf } from '../hint-layout'
import { grammarsReady } from '../markdown/__tests__/harness'
import { type SwitcherState } from '../switcher-model'
import { glyph } from '../theme'
import { frameOf } from './transcript-fixture'

await grammarsReady()

const WIDTH = 48

const NARROW = 34

const LONG_LABEL = 'sonnet-5-with-a-name-far-too-long-for-the-overlay'

const LONG_TAIL = 'for-the-overlay'

const ACTIVE = 'claude-sonnet-5'

const anthropic = (args: { id: string; label: string; price: number }): ModelEntry => ({
  id: args.id,
  label: args.label,
  vendor: EModelVendor.Anthropic,
  contextWindow: 200_000,
  inputPricePerMillion: 3,
  outputPricePerMillion: args.price,
})

const MODELS: readonly ModelEntry[] = [
  anthropic({ id: 'claude-opus-5', label: 'opus-5', price: 25 }),
  anthropic({ id: ACTIVE, label: 'sonnet-5', price: 15 }),
  anthropic({ id: 'claude-haiku-4-5', label: 'haiku-4-5', price: 0.8 }),
  {
    id: 'gpt-5-codex',
    label: 'gpt-5-codex',
    vendor: EModelVendor.OpenAI,
    contextWindow: 400_000,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 10,
  },
  {
    id: 'o4-mini',
    label: 'o4-mini',
    vendor: EModelVendor.OpenAI,
    contextWindow: 200_000,
    inputPricePerMillion: 1.1,
    outputPricePerMillion: 4.4,
  },
]

const VERBOSE: readonly ModelEntry[] = [anthropic({ id: ACTIVE, label: LONG_LABEL, price: 15 })]

const KEYED = new Set(MODELS.filter((model) => model.id !== 'o4-mini').map((model) => model.id))

const state = (index: number, effort: EEffort): SwitcherState => ({ index, effort })

function overlay(args: {
  state?: SwitcherState
  models?: readonly ModelEntry[]
}): React.ReactNode {
  return (
    <Switcher
      width={WIDTH}
      models={args.models ?? MODELS}
      state={args.state ?? state(1, EEffort.Medium)}
      activeModelId={ACTIVE}
      availability={KEYED}
      onPick={() => {}}
      onDismiss={() => {}}
    />
  )
}

async function rowsOf(node: React.ReactNode): Promise<string[]> {
  const frame = await frameOf(node, WIDTH)
  return frame.split('\n')
}

const rowWith = (rows: readonly string[], needle: string): string =>
  rows.find((row) => row.includes(needle)) ?? ''

const written = (rows: readonly string[]): string[] =>
  rows.map((row) => row.trimEnd()).filter((row) => row.replaceAll('│', '').trim().length > 0)

describe('what the switcher says', () => {
  it('names its three groups', async () => {
    const rows = await rowsOf(overlay({}))
    for (const header of ['MODEL', 'EFFORT', 'APPLIES']) {
      expect(rowWith(rows, header)).not.toBe('')
    }
  })

  it('keeps every row inside the overlay', async () => {
    const rows = await rowsOf(overlay({}))
    for (const row of rows) expect(cellsOf(row)).toBeLessThanOrEqual(WIDTH)
  })

  it('marks the running model once, and only once', async () => {
    const rows = await rowsOf(overlay({}))
    const marked = rows.filter((row) => row.includes(glyph.active))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain('sonnet-5')
  })

  it('prices an anthropic model to the cent and points elsewhere for the rest', async () => {
    const rows = await rowsOf(overlay({}))
    expect(rowWith(rows, 'haiku-4-5')).toContain('$0.80/M')
    expect(rowWith(rows, 'gpt-5-codex')).toContain('via openai')
  })

  it('says what is missing instead of a price when there is no credential', async () => {
    const rows = await rowsOf(overlay({}))
    const row = rowWith(rows, 'o4-mini')
    expect(row).toContain(`${glyph.warning} no key`)
    expect(row).not.toContain('$')
  })

  it('puts the effort marker on the pending level', async () => {
    const rows = await rowsOf(overlay({ state: state(1, EEffort.Medium) }))
    const row = rowWith(rows, EEffort.Low)
    expect(row).toContain(`${glyph.marker}${EFFORT_ABBREVIATION[EEffort.Medium]}`)
    expect(row).not.toContain(`${glyph.marker}${EFFORT_ABBREVIATION[EEffort.Low]}`)
    expect(row).toContain('← →')
  })

  it('moves the effort marker when the pending level moves', async () => {
    const rows = await rowsOf(overlay({ state: state(1, EEffort.High) }))
    const row = rowWith(rows, EEffort.High)
    expect(row).toContain(`${glyph.marker}${EFFORT_ABBREVIATION[EEffort.High]}`)
    expect(row).not.toContain(`${glyph.marker}${EFFORT_ABBREVIATION[EEffort.Medium]}`)
  })

  it('abbreviates every level, not only the one it marks', async () => {
    const rows = await rowsOf(overlay({ state: state(1, EEffort.Low) }))
    const row = rowWith(rows, EEffort.Low)
    expect(row).toContain('med')
    expect(row).not.toContain('medium')
  })

  it('says the switch lands on the next turn and spares the transcript', async () => {
    const rows = await rowsOf(overlay({}))
    const row = rowWith(rows, 'next turn')
    expect(row).toContain(glyph.swap)
    expect(row).toContain('keeps this transcript')
  })

  it('names the model you keep by walking away', async () => {
    const rows = written(await rowsOf(overlay({})))
    expect(rows.at(-1)).toContain('esc keep sonnet-5')
  })

  it('keeps the escape affordance when the row is too narrow to name the model', async () => {
    const frame = await frameOf(
      <Switcher
        width={NARROW}
        models={MODELS}
        state={state(1, EEffort.Medium)}
        activeModelId={ACTIVE}
        availability={KEYED}
        onPick={() => {}}
        onDismiss={() => {}}
      />,
      NARROW,
    )
    const rows = written(frame.split('\n'))
    expect(rows.at(-1)).toContain('esc keep')
    for (const row of frame.split('\n')) expect(cellsOf(row)).toBeLessThanOrEqual(NARROW)
  })

  it('truncates a label too long for the row rather than wrapping it', async () => {
    const rows = await rowsOf(overlay({ models: VERBOSE, state: state(0, EEffort.Medium) }))
    expect(rowWith(rows, '…')).toContain('$15.00/M')
    for (const row of rows) expect(row).not.toContain(LONG_TAIL)
  })
})
