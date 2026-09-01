import { describe, expect, it } from 'bun:test'

import {
  EEffort,
  EImageTier,
  type EffortMap,
  type ModelCard,
  type ModelCost,
} from '@dltech/atlas-core'

import {
  adjustEffort,
  anchorOn,
  cardAt,
  ESwitcherRow,
  FAVOURITES_GROUP_LABEL,
  modelCount,
  moveSelection,
  openSwitcher,
  priceLabel,
  resolve,
  selectAt,
  selectedCard,
  shownCount,
  switcherRows,
  type SwitcherProvider,
  type SwitcherRow,
  type SwitcherState,
} from '../switcher-model'

const LADDER: EffortMap = {
  [EEffort.Low]: 'low',
  [EEffort.Medium]: 'medium',
  [EEffort.High]: 'high',
}

const card = (args: {
  providerId: string
  modelId: string
  effort?: EffortMap | undefined
  cost?: ModelCost | undefined
}): ModelCard => ({
  ref: { providerId: args.providerId, modelId: args.modelId },
  label: args.modelId,
  api: 'messages',
  contextWindow: 200_000,
  imageTier: EImageTier.HighResolution,
  ...(args.effort === undefined ? {} : { effort: args.effort }),
  ...(args.cost === undefined ? {} : { cost: args.cost }),
})

const PROVIDERS: readonly SwitcherProvider[] = [
  {
    id: 'anthropic',
    label: 'Claude Plan',
    cards: [
      card({ providerId: 'anthropic', modelId: 'a', effort: LADDER }),
      card({ providerId: 'anthropic', modelId: 'b', effort: LADDER }),
      card({
        providerId: 'anthropic',
        modelId: 'c',
        effort: { [EEffort.Minimal]: 1024, [EEffort.Low]: 4096 },
      }),
    ],
  },
  {
    id: 'openai',
    label: 'Codex Plan',
    cards: [
      card({ providerId: 'openai', modelId: 'd', effort: LADDER }),
      card({ providerId: 'openai', modelId: 'e' }),
    ],
  },
]

const ALL_KEYED = new Set(['anthropic', 'openai'])

const rowsOf = (availability?: ReadonlySet<string>): readonly SwitcherRow[] =>
  switcherRows({ providers: PROVIDERS, ...(availability === undefined ? {} : { availability }) })

const at = (index: number, effort: EEffort = EEffort.Medium): SwitcherState => ({ index, effort })

describe('laying the catalogue out as rows', () => {
  it('heads each provider before the models it serves', () => {
    const rows = rowsOf(ALL_KEYED)
    expect(rows.map((row) => row.kind)).toEqual([
      ESwitcherRow.Header,
      ESwitcherRow.Model,
      ESwitcherRow.Model,
      ESwitcherRow.Model,
      ESwitcherRow.Header,
      ESwitcherRow.Model,
      ESwitcherRow.Model,
    ])
  })

  it('marks every model of a provider with no account as out of reach', () => {
    const rows = rowsOf(new Set(['anthropic']))
    const reach = rows.flatMap((row) => (row.kind === ESwitcherRow.Model ? [row.available] : []))
    expect(reach).toEqual([true, true, true, false, false])
  })

  it('leaves out a provider that serves nothing', () => {
    const rows = switcherRows({ providers: [{ id: 'empty', label: 'Empty', cards: [] }] })
    expect(rows).toEqual([])
  })
})

describe('filtering the catalogue', () => {
  it('keeps only the models whose name carries what was typed', () => {
    const rows = switcherRows({ providers: PROVIDERS, availability: ALL_KEYED, query: 'd' })
    expect(
      rows.map((row) => (row.kind === ESwitcherRow.Model ? row.card.label : row.label)),
    ).toEqual(['Codex Plan', 'd'])
  })

  it('drops a provider whose every model was filtered out', () => {
    const rows = switcherRows({ providers: PROVIDERS, availability: ALL_KEYED, query: 'openai/' })
    expect(rows.filter((row) => row.kind === ESwitcherRow.Header)).toHaveLength(1)
  })

  it('reads the qualified ref as readily as the label', () => {
    const rows = switcherRows({
      providers: PROVIDERS,
      availability: ALL_KEYED,
      query: 'anthropic/b',
    })
    expect(rows).toHaveLength(2)
  })

  it('says nothing matched rather than pretending the catalogue is empty', () => {
    expect(switcherRows({ providers: PROVIDERS, query: 'nothing-like-it' })).toEqual([])
  })
})

describe('anchoring after the rows change', () => {
  it('follows the model that survived the filter', () => {
    const rows = switcherRows({ providers: PROVIDERS, availability: ALL_KEYED, query: 'd' })
    const state = anchorOn({
      rows,
      active: { providerId: 'openai', modelId: 'd' },
      effort: EEffort.High,
    })
    expect(state).toEqual({ index: 1, effort: EEffort.High })
  })

  it('falls to the first pickable row when the held model was filtered away', () => {
    const rows = switcherRows({ providers: PROVIDERS, availability: ALL_KEYED, query: 'd' })
    const state = anchorOn({
      rows,
      active: { providerId: 'anthropic', modelId: 'a' },
      effort: EEffort.High,
    })
    expect(state.index).toBe(1)
  })

  it('holds at the first row when the filter matched nothing', () => {
    expect(anchorOn({ rows: [], active: undefined, effort: EEffort.Low })).toEqual({
      index: 0,
      effort: EEffort.Low,
    })
  })
})

describe('opening the switcher', () => {
  it('starts on the row the session is already running', () => {
    const state = openSwitcher({
      providers: PROVIDERS,
      active: { providerId: 'openai', modelId: 'd' },
      effort: EEffort.High,
      availability: ALL_KEYED,
    })
    expect(state.index).toBe(5)
  })

  it('falls back to the first model that can be picked when the active one is gone', () => {
    const state = openSwitcher({
      providers: PROVIDERS,
      active: { providerId: 'nothing', modelId: 'like-it' },
      effort: EEffort.Low,
      availability: new Set(['openai']),
    })
    expect(state.index).toBe(5)
  })

  it('clamps the held rung onto what the landing model offers', () => {
    const state = openSwitcher({
      providers: PROVIDERS,
      active: { providerId: 'anthropic', modelId: 'c' },
      effort: EEffort.High,
      availability: ALL_KEYED,
    })
    expect(state).toEqual({ index: 3, effort: EEffort.Low })
  })
})

describe('moving the selection', () => {
  it('steps over the header between two providers', () => {
    const rows = rowsOf(ALL_KEYED)
    expect(moveSelection({ state: at(3), delta: 1, rows }).index).toBe(5)
    expect(moveSelection({ state: at(5), delta: -1, rows }).index).toBe(3)
  })

  it('never lands on a header row', () => {
    const rows = rowsOf(ALL_KEYED)
    for (let index = 1; index < rows.length; index += 1) {
      const landed = moveSelection({ state: at(index), delta: -1, rows })
      expect(rows[landed.index]?.kind).toBe(ESwitcherRow.Model)
    }
  })

  it('skips a provider with no account in both directions', () => {
    const rows = rowsOf(new Set(['openai']))
    expect(moveSelection({ state: at(1), delta: 1, rows }).index).toBe(5)
    expect(moveSelection({ state: at(6), delta: -1, rows }).index).toBe(5)
  })

  it('clamps at both ends rather than wrapping', () => {
    const rows = rowsOf(ALL_KEYED)
    expect(moveSelection({ state: at(6), delta: 1, rows }).index).toBe(6)
    expect(moveSelection({ state: at(1), delta: -1, rows }).index).toBe(1)
  })

  it('drops the held rung to one the landing model actually offers', () => {
    const rows = rowsOf(ALL_KEYED)
    expect(moveSelection({ state: at(2, EEffort.High), delta: 1, rows }).effort).toBe(EEffort.Low)
  })

  it('leaves the rung alone when the landing model has it', () => {
    const rows = rowsOf(ALL_KEYED)
    expect(moveSelection({ state: at(1, EEffort.High), delta: 1, rows }).effort).toBe(EEffort.High)
  })

  it('does not throw on an empty catalogue', () => {
    const state = openSwitcher({
      providers: [],
      active: { providerId: 'anthropic', modelId: 'a' },
      effort: EEffort.Low,
    })
    expect(state.index).toBe(0)
    expect(moveSelection({ state, delta: 1, rows: [] }).index).toBe(0)
    expect(resolve({ state, rows: [] })).toEqual({ ref: null, effort: EEffort.Low })
  })
})

describe('adjusting the effort', () => {
  it('steps a rung at a time on the selected model', () => {
    const rows = rowsOf(ALL_KEYED)
    expect(adjustEffort({ state: at(1, EEffort.Low), delta: 1, rows }).effort).toBe(EEffort.Medium)
    expect(adjustEffort({ state: at(1, EEffort.High), delta: -1, rows }).effort).toBe(
      EEffort.Medium,
    )
  })

  it('walks only the rungs that model has, not the whole ladder', () => {
    const rows = rowsOf(ALL_KEYED)
    expect(adjustEffort({ state: at(3, EEffort.Minimal), delta: 1, rows }).effort).toBe(EEffort.Low)
    expect(adjustEffort({ state: at(3, EEffort.Low), delta: 1, rows }).effort).toBe(EEffort.Low)
  })

  it('holds the rung when the model cannot reason at all', () => {
    const rows = rowsOf(ALL_KEYED)
    expect(adjustEffort({ state: at(6, EEffort.Medium), delta: 1, rows }).effort).toBe(
      EEffort.Medium,
    )
  })

  it('leaves the highlighted row where it was', () => {
    const rows = rowsOf(ALL_KEYED)
    expect(adjustEffort({ state: at(2, EEffort.Low), delta: 1, rows }).index).toBe(2)
  })
})

describe('resolving what to apply', () => {
  it('names the highlighted model and the pending rung', () => {
    const rows = rowsOf(ALL_KEYED)
    expect(resolve({ state: at(5, EEffort.High), rows })).toEqual({
      ref: { providerId: 'openai', modelId: 'd' },
      effort: EEffort.High,
    })
  })

  it('refuses to name a header row', () => {
    const rows = rowsOf(ALL_KEYED)
    expect(resolve({ state: at(0, EEffort.High), rows }).ref).toBeNull()
    expect(selectedCard({ state: at(0), rows })).toBeUndefined()
  })
})

describe('the price read-out', () => {
  it('spells the output price to the cent', () => {
    const priced = card({
      providerId: 'anthropic',
      modelId: 'a',
      cost: { inputPerMillion: 1, outputPerMillion: 5 },
    })
    expect(priceLabel(priced)).toBe('$5.00/M')
    expect(priceLabel({ ...priced, cost: { inputPerMillion: 1, outputPerMillion: 0.8 } })).toBe(
      '$0.80/M',
    )
  })

  it('says nothing rather than free when the cost is unknown', () => {
    expect(priceLabel(card({ providerId: 'anthropic', modelId: 'a' }))).toBeNull()
  })
})

describe('how many models there are to choose from', () => {
  it('counts every card the providers offer, keyed or not', () => {
    expect(modelCount(PROVIDERS)).toBe(5)
  })

  it('counts the models a filter left standing, not the headings over them', () => {
    expect(shownCount(switcherRows({ providers: PROVIDERS }))).toBe(5)
    expect(shownCount(switcherRows({ providers: PROVIDERS, query: 'openai/' }))).toBe(2)
    expect(shownCount(switcherRows({ providers: PROVIDERS, query: 'nothing' }))).toBe(0)
  })
})

const labelsUnder = (args: { rows: readonly SwitcherRow[]; heading: string }): string[] => {
  const opened = args.rows.findIndex(
    (row) => row.kind === ESwitcherRow.Header && row.label === args.heading,
  )
  if (opened < 0) return []

  const taken: string[] = []
  for (const row of args.rows.slice(opened + 1)) {
    if (row.kind !== ESwitcherRow.Model) break
    taken.push(row.card.label)
  }
  return taken
}

const headings = (rows: readonly SwitcherRow[]): string[] =>
  rows.flatMap((row) => (row.kind === ESwitcherRow.Header ? [row.label] : []))

describe('the models pinned to the top', () => {
  it('heads no group of its own until something is pinned', () => {
    expect(headings(switcherRows({ providers: PROVIDERS }))).not.toContain(FAVOURITES_GROUP_LABEL)
  })

  it('gathers the pinned models into the first group', () => {
    const rows = switcherRows({ providers: PROVIDERS, favourites: ['openai/d'] })
    expect(headings(rows)[0]).toBe(FAVOURITES_GROUP_LABEL)
    expect(labelsUnder({ rows, heading: FAVOURITES_GROUP_LABEL })).toEqual(['d'])
  })

  it('lifts a pinned model out of its provider rather than showing it twice', () => {
    const rows = switcherRows({ providers: PROVIDERS, favourites: ['openai/d'] })
    expect(labelsUnder({ rows, heading: 'Codex Plan' })).toEqual(['e'])
    expect(
      rows.filter((row) => row.kind === ESwitcherRow.Model && row.card.label === 'd'),
    ).toHaveLength(1)
  })

  it('holds the pins in the order they were made, not the order the catalogue is in', () => {
    const rows = switcherRows({ providers: PROVIDERS, favourites: ['openai/d', 'anthropic/a'] })
    expect(labelsUnder({ rows, heading: FAVOURITES_GROUP_LABEL })).toEqual(['d', 'a'])
  })

  it('drops a group left empty by pinning everything under it', () => {
    const rows = switcherRows({ providers: PROVIDERS, favourites: ['openai/d', 'openai/e'] })
    expect(headings(rows)).not.toContain('Codex Plan')
  })

  it('keeps a pinned model on the reachability of the provider it came from', () => {
    const rows = switcherRows({
      providers: PROVIDERS,
      availability: new Set(['anthropic']),
      favourites: ['openai/d', 'anthropic/a'],
    })
    const pinned = rows.filter((row) => row.kind === ESwitcherRow.Model).slice(0, 2)
    expect(pinned.map((row) => (row.kind === ESwitcherRow.Model ? row.available : null))).toEqual([
      false,
      true,
    ])
  })

  it('ignores a pin for a model the catalogue no longer carries', () => {
    const rows = switcherRows({ providers: PROVIDERS, favourites: ['gone/away'] })
    expect(headings(rows)).not.toContain(FAVOURITES_GROUP_LABEL)
  })

  it('only pins what the filter left standing', () => {
    const rows = switcherRows({
      providers: PROVIDERS,
      favourites: ['openai/d'],
      query: 'anthropic/',
    })
    expect(headings(rows)).not.toContain(FAVOURITES_GROUP_LABEL)
  })

  it('opens on the running model wherever pinning has moved it', () => {
    const state = openSwitcher({
      providers: PROVIDERS,
      active: { providerId: 'openai', modelId: 'd' },
      effort: EEffort.Medium,
      favourites: ['openai/d'],
    })
    const rows = switcherRows({ providers: PROVIDERS, favourites: ['openai/d'] })
    expect(cardAt({ rows, index: state.index })?.label).toBe('d')
  })
})

describe('naming a row outright', () => {
  it('takes the highlight to the row that was named', () => {
    const rows = rowsOf(ALL_KEYED)
    const moved = selectAt({ state: { index: 1, effort: EEffort.Medium }, index: 2, rows })
    expect(moved.index).toBe(2)
  })

  it('stays put when the row named is a heading', () => {
    const rows = rowsOf(ALL_KEYED)
    const held = { index: 1, effort: EEffort.Medium }
    expect(selectAt({ state: held, index: 0, rows })).toBe(held)
  })

  it('stays put when the row named has no key behind it', () => {
    const rows = rowsOf(new Set(['anthropic']))
    const openai = rows.findIndex((row) => row.kind === ESwitcherRow.Model && !row.available)
    const held = { index: 1, effort: EEffort.Medium }
    expect(selectAt({ state: held, index: openai, rows })).toBe(held)
  })

  it('clamps the effort to what the row it landed on can do', () => {
    const rows = rowsOf(ALL_KEYED)
    const minimal = rows.findIndex(
      (row) => row.kind === ESwitcherRow.Model && row.card.label === 'c',
    )
    const landed = selectAt({ state: { index: 1, effort: EEffort.High }, index: minimal, rows })
    expect(landed.effort).not.toBe(EEffort.High)
  })
})
