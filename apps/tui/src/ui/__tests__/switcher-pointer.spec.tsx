import { parseColor } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act, useCallback, useState } from 'react'

import {
  EEffort,
  EImageTier,
  type EffortMap,
  type ModelCard,
  type ModelRef,
} from '@dltech/atlas-core'

import { Switcher } from '../components/switcher'
import { grammarsReady, teardown } from '../markdown/__tests__/harness'
import {
  modelCount,
  selectAt,
  switcherRows,
  type SwitcherChoice,
  type SwitcherProvider,
  type SwitcherState,
} from '../switcher-model'
import { theme } from '../theme'
import { HEIGHT } from './transcript-fixture'

await grammarsReady()

const WIDTH = 48

const ACTIVE: ModelRef = { providerId: 'anthropic', modelId: 'sonnet-5' }

const LADDER: EffortMap = {
  [EEffort.Low]: 'low',
  [EEffort.Medium]: 'medium',
  [EEffort.High]: 'high',
}

const card = (args: { providerId: string; modelId: string }): ModelCard => ({
  ref: { providerId: args.providerId, modelId: args.modelId },
  label: args.modelId,
  api: 'messages',
  contextWindow: 200_000,
  imageTier: EImageTier.HighResolution,
  cost: { inputPerMillion: 3, outputPerMillion: 15 },
  effort: LADDER,
})

const PROVIDERS: readonly SwitcherProvider[] = [
  {
    id: 'anthropic',
    label: 'Claude Plan',
    cards: [
      card({ providerId: 'anthropic', modelId: 'opus-5' }),
      card({ providerId: 'anthropic', modelId: 'sonnet-5' }),
      card({ providerId: 'anthropic', modelId: 'haiku-4-5' }),
    ],
  },
  {
    id: 'openai',
    label: 'Codex Plan',
    cards: [card({ providerId: 'openai', modelId: 'gpt-5-codex' })],
  },
]

const KEYED = new Set(['anthropic'])

const ROWS = switcherRows({ providers: PROVIDERS, availability: KEYED })

type Colour = { equals: (other: unknown) => boolean }

type Painted = { text: string; fg: Colour; bg: Colour }

type Spans = { lines: ({ spans: Painted[] } | undefined)[] }

const groundAt = (spans: Spans, row: number, cell: number): Colour | undefined => {
  let column = 0
  for (const span of spans.lines[row]?.spans ?? []) {
    const width = [...span.text].length
    if (cell < column + width) return span.bg
    column += width
  }
  return undefined
}

function Browsing(props: {
  opened: number
  onPick?: (choice: SwitcherChoice) => void
}): React.ReactNode {
  const [state, setState] = useState<SwitcherState>({
    index: props.opened,
    effort: EEffort.Medium,
  })

  const handleSelect = useCallback(
    (index: number) => setState((held) => selectAt({ state: held, index, rows: ROWS })),
    [],
  )

  return (
    <Switcher
      width={WIDTH}
      rows={ROWS}
      state={state}
      active={ACTIVE}
      total={modelCount(PROVIDERS)}
      overlay
      onPick={props.onPick ?? (() => {})}
      onSelect={handleSelect}
      onDismiss={() => {}}
    />
  )
}

type Mounted = Awaited<ReturnType<typeof testRender>>

const mount = async (node: React.ReactNode): Promise<Mounted> => {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      {node}
    </box>,
    { width: WIDTH, height: HEIGHT },
  )
  await setup.flush()
  return setup
}

const rowOf = (setup: Mounted, label: string): number =>
  setup
    .captureCharFrame()
    .split('\n')
    .findIndex((line) => line.includes(label))

const LABEL_CELL = 6

describe('what the pointer does to the model list', () => {
  it('takes the highlight to the row that was clicked, without switching model', async () => {
    const picked: SwitcherChoice[] = []
    const setup = await mount(<Browsing opened={1} onPick={(choice) => picked.push(choice)} />)

    try {
      const row = rowOf(setup, 'haiku-4-5')
      expect(row).toBeGreaterThan(0)

      await act(async () => {
        await setup.mockMouse.click(LABEL_CELL, row)
      })
      await setup.flush()

      const spans = setup.captureSpans() as unknown as Spans
      expect(groundAt(spans, row, LABEL_CELL)?.equals(parseColor(theme.selectedBg))).toBe(true)
      expect(picked).toHaveLength(0)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('leaves the row it came from unbanded', async () => {
    const setup = await mount(<Browsing opened={1} />)

    try {
      const opus = rowOf(setup, 'opus-5')
      const haiku = rowOf(setup, 'haiku-4-5')

      await act(async () => {
        await setup.mockMouse.click(LABEL_CELL, haiku)
      })
      await setup.flush()

      const spans = setup.captureSpans() as unknown as Spans
      expect(groundAt(spans, opus, LABEL_CELL)?.equals(parseColor(theme.selectedBg))).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('bands the row under the pointer more softly than the one it would switch to', async () => {
    const setup = await mount(<Browsing opened={1} />)

    try {
      const selected = rowOf(setup, 'opus-5')
      const hovered = rowOf(setup, 'haiku-4-5')

      await act(async () => {
        await setup.mockMouse.moveTo(LABEL_CELL, hovered)
      })
      await setup.flush()

      const spans = setup.captureSpans() as unknown as Spans
      expect(groundAt(spans, hovered, LABEL_CELL)?.equals(parseColor(theme.hoverBg))).toBe(true)
      expect(groundAt(spans, selected, LABEL_CELL)?.equals(parseColor(theme.selectedBg))).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('gives the band back when the pointer leaves the row', async () => {
    const setup = await mount(<Browsing opened={1} />)

    try {
      const hovered = rowOf(setup, 'haiku-4-5')
      const heading = rowOf(setup, 'MODEL')

      await act(async () => {
        await setup.mockMouse.moveTo(LABEL_CELL, hovered)
      })
      await setup.flush()
      const lit = setup.captureSpans() as unknown as Spans
      expect(groundAt(lit, hovered, LABEL_CELL)?.equals(parseColor(theme.hoverBg))).toBe(true)

      await act(async () => {
        await setup.mockMouse.moveTo(LABEL_CELL, heading)
      })
      await setup.flush()
      const dark = setup.captureSpans() as unknown as Spans
      expect(groundAt(dark, hovered, LABEL_CELL)?.equals(parseColor(theme.hoverBg))).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('offers no band on a model there is no key for', async () => {
    const setup = await mount(<Browsing opened={1} />)

    try {
      const locked = rowOf(setup, 'gpt-5-codex')

      await act(async () => {
        await setup.mockMouse.moveTo(LABEL_CELL, locked)
      })
      await setup.flush()

      const spans = setup.captureSpans() as unknown as Spans
      expect(groundAt(spans, locked, LABEL_CELL)?.equals(parseColor(theme.hoverBg))).toBe(false)
      expect(groundAt(spans, locked, LABEL_CELL)?.equals(parseColor(theme.selectedBg))).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('will not take the highlight to a model there is no key for', async () => {
    const setup = await mount(<Browsing opened={1} />)

    try {
      const locked = rowOf(setup, 'gpt-5-codex')
      const held = rowOf(setup, 'opus-5')

      await act(async () => {
        await setup.mockMouse.click(LABEL_CELL, locked)
      })
      await setup.flush()

      const spans = setup.captureSpans() as unknown as Spans
      expect(groundAt(spans, held, LABEL_CELL)?.equals(parseColor(theme.selectedBg))).toBe(true)
      expect(groundAt(spans, locked, LABEL_CELL)?.equals(parseColor(theme.selectedBg))).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})
