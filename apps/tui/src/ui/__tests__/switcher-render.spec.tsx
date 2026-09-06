import { describe, expect, it } from 'bun:test'
import React from 'react'

import {
  EEffort,
  EImageTier,
  ESettingId,
  type EffortMap,
  type ModelCard,
  type ModelRef,
} from '@dltech/atlas-core'

import { EFFORT_ABBREVIATION, Switcher } from '../components/switcher'
import { cellsOf } from '../hint-layout'
import { grammarsReady } from '../markdown/__tests__/harness'
import {
  EModelScope,
  modelCount,
  switcherRows,
  THREAD_TARGET,
  type SwitcherProvider,
  type SwitcherState,
  type SwitcherTarget,
} from '../switcher-model'
import { glyph } from '../theme'
import { frameOf } from './transcript-fixture'

await grammarsReady()

const WIDTH = 48

const NARROW = 34

const WIDE = 60

const LONG_LABEL = 'sonnet-5-with-a-name-far-too-long-for-the-overlay'

const LONG_TAIL = 'for-the-overlay'

const ACTIVE: ModelRef = { providerId: 'anthropic', modelId: 'claude-sonnet-5' }

const LADDER: EffortMap = {
  [EEffort.Low]: 'low',
  [EEffort.Medium]: 'medium',
  [EEffort.High]: 'high',
}

const card = (args: {
  providerId: string
  modelId: string
  label: string
  price?: number | undefined
  effort?: EffortMap | undefined
}): ModelCard => ({
  ref: { providerId: args.providerId, modelId: args.modelId },
  label: args.label,
  api: 'messages',
  contextWindow: 200_000,
  imageTier: EImageTier.HighResolution,
  ...(args.price === undefined
    ? {}
    : { cost: { inputPerMillion: 3, outputPerMillion: args.price } }),
  ...(args.effort === undefined ? {} : { effort: args.effort }),
})

const PROVIDERS: readonly SwitcherProvider[] = [
  {
    id: 'anthropic',
    label: 'Claude Plan',
    cards: [
      card({
        providerId: 'anthropic',
        modelId: 'claude-opus-5',
        label: 'opus-5',
        price: 25,
        effort: LADDER,
      }),
      card({
        providerId: 'anthropic',
        modelId: 'claude-sonnet-5',
        label: 'sonnet-5',
        price: 15,
        effort: LADDER,
      }),
      card({
        providerId: 'anthropic',
        modelId: 'claude-haiku-4-5',
        label: 'haiku-4-5',
        price: 0.8,
        effort: LADDER,
      }),
      card({ providerId: 'anthropic', modelId: 'claude-instant', label: 'instant' }),
    ],
  },
  {
    id: 'openai',
    label: 'Codex Plan',
    cards: [
      card({
        providerId: 'openai',
        modelId: 'gpt-5-codex',
        label: 'gpt-5-codex',
        price: 10,
        effort: LADDER,
      }),
    ],
  },
]

const VERBOSE: readonly SwitcherProvider[] = [
  {
    id: 'anthropic',
    label: 'Claude Plan',
    cards: [
      card({
        providerId: 'anthropic',
        modelId: 'claude-sonnet-5',
        label: LONG_LABEL,
        price: 15,
        effort: LADDER,
      }),
    ],
  },
]

const CROWD_SIZE = 60

const CROWDED: readonly SwitcherProvider[] = [
  {
    id: 'anthropic',
    label: 'Claude Plan',
    cards: Array.from({ length: CROWD_SIZE }, (_, index) =>
      card({
        providerId: 'anthropic',
        modelId: `model-${index}`,
        label: `model-${index}`,
        price: 5,
        effort: LADDER,
      }),
    ),
  },
]

const KEYED = new Set(['anthropic'])

const state = (index: number, effort: EEffort): SwitcherState => ({ index, effort })

const DEFAULT_MODEL_TARGET: SwitcherTarget = {
  scope: EModelScope.Setting,
  id: ESettingId.ModelId,
  label: 'Default model',
  withEffort: true,
}

function overlay(args: {
  state?: SwitcherState
  providers?: readonly SwitcherProvider[]
  width?: number
  query?: string
  target?: SwitcherTarget
}): React.ReactNode {
  const laid = switcherRows({
    providers: args.providers ?? PROVIDERS,
    availability: KEYED,
    ...(args.query === undefined ? {} : { query: args.query }),
  })

  return (
    <Switcher
      width={args.width ?? WIDTH}
      rows={laid}
      state={args.state ?? state(2, EEffort.Medium)}
      active={ACTIVE}
      target={args.target ?? THREAD_TARGET}
      overlay
      total={modelCount(args.providers ?? PROVIDERS)}
      {...(args.query === undefined ? {} : { query: args.query })}
      onPick={() => {}}
      onSelect={() => {}}
      onDismiss={() => {}}
    />
  )
}

async function rowsOf(node: React.ReactNode, width = WIDTH): Promise<string[]> {
  const frame = await frameOf(node, width)
  return frame.split('\n')
}

const rowWith = (lines: readonly string[], needle: string): string =>
  lines.find((line) => line.includes(needle)) ?? ''

const written = (lines: readonly string[]): string[] =>
  lines.map((line) => line.trimEnd()).filter((line) => line.replaceAll('│', '').trim().length > 0)

describe('what the switcher says', () => {
  it('names its three groups', async () => {
    const lines = await rowsOf(overlay({}))
    for (const header of ['MODEL', 'EFFORT', 'APPLIES']) {
      expect(rowWith(lines, header)).not.toBe('')
    }
  })

  it('heads each provider over the models it serves', async () => {
    const lines = await rowsOf(overlay({}))
    expect(rowWith(lines, 'Claude Plan')).not.toBe('')
    expect(rowWith(lines, 'Codex Plan')).not.toBe('')
  })

  it('keeps every row inside the overlay', async () => {
    const lines = await rowsOf(overlay({}))
    for (const line of lines) expect(cellsOf(line)).toBeLessThanOrEqual(WIDTH)
  })

  it('marks the running model once, and only once', async () => {
    const lines = await rowsOf(overlay({}))
    const marked = lines.filter((line) => line.includes(glyph.active))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain('sonnet-5')
  })

  it('prices a model to the cent', async () => {
    const lines = await rowsOf(overlay({}))
    expect(rowWith(lines, 'haiku-4-5')).toContain('$0.80/M')
  })

  it('says nothing rather than free when the cost is unknown', async () => {
    const lines = await rowsOf(overlay({}))
    expect(rowWith(lines, 'instant')).not.toContain('$')
  })

  it('says what is missing instead of a price when the provider has no account', async () => {
    const lines = await rowsOf(overlay({}))
    const line = rowWith(lines, 'gpt-5-codex')
    expect(line).toContain(`${glyph.warning} no key`)
    expect(line).not.toContain('$')
  })

  it('puts the effort marker on the pending level', async () => {
    const lines = await rowsOf(overlay({ state: state(2, EEffort.Medium) }))
    const line = rowWith(lines, EEffort.Low)
    expect(line).toContain(`${glyph.marker}${EFFORT_ABBREVIATION[EEffort.Medium]}`)
    expect(line).not.toContain(`${glyph.marker}${EFFORT_ABBREVIATION[EEffort.Low]}`)
    expect(line).toContain('← →')
  })

  it('moves the effort marker when the pending level moves', async () => {
    const lines = await rowsOf(overlay({ state: state(2, EEffort.High) }))
    const line = rowWith(lines, EEffort.High)
    expect(line).toContain(`${glyph.marker}${EFFORT_ABBREVIATION[EEffort.High]}`)
    expect(line).not.toContain(`${glyph.marker}${EFFORT_ABBREVIATION[EEffort.Medium]}`)
  })

  it('abbreviates every rung, not only the one it marks', async () => {
    const lines = await rowsOf(overlay({ state: state(2, EEffort.Low) }))
    const line = rowWith(lines, EEffort.Low)
    expect(line).toContain('med')
    expect(line).not.toContain('medium')
  })

  it('drops the whole effort group for a model that cannot reason', async () => {
    const lines = await rowsOf(overlay({ state: state(4, EEffort.Medium) }))
    expect(rowWith(lines, 'EFFORT')).toBe('')
    expect(rowWith(lines, 'APPLIES')).not.toBe('')
  })

  it('says the switch lands on the next turn and reaches no further than this conversation', async () => {
    const lines = await rowsOf(overlay({}))
    const line = rowWith(lines, 'next turn')
    expect(line).toContain(glyph.swap)
    expect(line).toContain('this conversation only')
  })

  it('says the picker set on the default reaches every new conversation instead', async () => {
    const lines = await rowsOf(overlay({ target: DEFAULT_MODEL_TARGET }))
    expect(rowWith(lines, 'the default')).toContain('every new conversation')
    expect(rowWith(lines, 'DEFAULT MODEL')).not.toBe('')
  })

  it('names the model you keep by walking away when the row is wide enough', async () => {
    const lines = written(await rowsOf(overlay({ width: WIDE }), WIDE))
    expect(lines.at(-1)).toContain('esc keep sonnet-5')
  })

  it('spends the last of a narrow row on the pin key rather than on the name', async () => {
    const lines = written(await rowsOf(overlay({})))
    expect(lines.at(-1)).toContain('* pin')
    expect(lines.at(-1)).toContain('esc keep')
    expect(lines.at(-1)).not.toContain('sonnet-5')
  })

  it('keeps the escape affordance when the row is too narrow to name the model', async () => {
    const lines = await rowsOf(overlay({ width: NARROW }), NARROW)
    expect(written(lines).at(-1)).toContain('esc keep')
    for (const line of lines) expect(cellsOf(line)).toBeLessThanOrEqual(NARROW)
  })

  it('truncates a label too long for the row rather than wrapping it', async () => {
    const lines = await rowsOf(overlay({ providers: VERBOSE, state: state(1, EEffort.Medium) }))
    expect(rowWith(lines, '…')).toContain('$15.00/M')
    for (const line of lines) expect(line).not.toContain(LONG_TAIL)
  })
})

describe('a catalogue too long for the drawer', () => {
  it('keeps the effort, applies and footer rows on screen', async () => {
    const lines = written(
      await rowsOf(overlay({ providers: CROWDED, state: state(1, EEffort.Medium) })),
    )
    expect(rowWith(lines, 'EFFORT')).not.toBe('')
    expect(rowWith(lines, 'APPLIES')).not.toBe('')
    expect(lines.at(-1)).toContain('esc keep')
  })

  it('scrolls the pick into view when it sits past the fold', async () => {
    const last = CROWD_SIZE
    const lines = await rowsOf(overlay({ providers: CROWDED, state: state(last, EEffort.Medium) }))
    expect(rowWith(lines, `model-${CROWD_SIZE - 1} `)).not.toBe('')
  })

  it('leaves the rows above the fold off screen once it has scrolled', async () => {
    const lines = await rowsOf(
      overlay({ providers: CROWDED, state: state(CROWD_SIZE, EEffort.Medium) }),
    )
    expect(rowWith(lines, 'model-0 ')).toBe('')
  })

  it('holds the head of the list before anything has scrolled', async () => {
    const lines = await rowsOf(overlay({ providers: CROWDED, state: state(1, EEffort.Medium) }))
    expect(rowWith(lines, 'model-0 ')).not.toBe('')
    expect(rowWith(lines, `model-${CROWD_SIZE - 1} `)).toBe('')
  })
})

describe('the filter the switcher offers', () => {
  it('says a name can be typed before one has been', async () => {
    const lines = await rowsOf(overlay({}))
    expect(rowWith(lines, 'type to filter')).not.toBe('')
  })

  it('counts the whole catalogue when nothing is typed', async () => {
    const lines = await rowsOf(overlay({}))
    expect(rowWith(lines, 'type to filter')).toContain(`${modelCount(PROVIDERS)}`)
  })

  it('shows what was typed in place of the invitation', async () => {
    const lines = await rowsOf(overlay({ query: 'haiku', state: state(1, EEffort.Medium) }))
    expect(rowWith(lines, 'haiku')).not.toContain('type to filter')
    expect(rowWith(lines, 'haiku-4-5')).not.toBe('')
  })

  it('counts the matches against the catalogue while filtering', async () => {
    const lines = await rowsOf(overlay({ query: 'haiku', state: state(1, EEffort.Medium) }))
    expect(rowWith(lines, `1 of ${modelCount(PROVIDERS)}`)).not.toBe('')
  })

  it('says so rather than showing an empty list when nothing matches', async () => {
    const lines = await rowsOf(overlay({ query: 'nothing-of-the-kind' }))
    expect(rowWith(lines, 'no model by that name')).not.toBe('')
    expect(rowWith(lines, `0 of ${modelCount(PROVIDERS)}`)).not.toBe('')
  })
})
