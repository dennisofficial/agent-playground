import { describe, expect, it } from 'bun:test'

import { EEffort, EImageTier, EModelVendor, EThinkingControl, type ModelEntry } from '@dltech/atlas-core'

import {
  adjustEffort,
  isModelAvailable,
  moveSelection,
  openSwitcher,
  priceLabel,
  resolve,
  type SwitcherState,
} from '../switcher-model'

const entry = (id: string, vendor: EModelVendor = EModelVendor.Anthropic): ModelEntry => ({
  id,
  label: id,
  vendor,
  contextWindow: 200_000,
  thinkingControl: EThinkingControl.Effort,
  inputPricePerMillion: 1,
  outputPricePerMillion: 5,
  imageTier: EImageTier.HighResolution,
})

const MODELS: readonly ModelEntry[] = [
  entry('a'),
  entry('b'),
  entry('c'),
  entry('d'),
  entry('e'),
]

const ALL_KEYED = new Set(MODELS.map((model) => model.id))

const ONLY_ENDS = new Set(['a', 'e'])

const at = (index: number, effort: EEffort = EEffort.Medium): SwitcherState => ({ index, effort })

describe('opening the switcher', () => {
  it('starts on the model the session is already running', () => {
    const state = openSwitcher({
      models: MODELS,
      activeModelId: 'c',
      effort: EEffort.High,
      availability: ALL_KEYED,
    })
    expect(state).toEqual({ index: 2, effort: EEffort.High })
  })

  it('falls back to the first model that can be picked when the active one is gone', () => {
    const state = openSwitcher({
      models: MODELS,
      activeModelId: 'nothing-like-it',
      effort: EEffort.Low,
      availability: ONLY_ENDS,
    })
    expect(state.index).toBe(0)
  })

  it('holds at the first row when nothing is available at all', () => {
    const state = openSwitcher({
      models: MODELS,
      activeModelId: 'nothing-like-it',
      effort: EEffort.Low,
      availability: new Set<string>(),
    })
    expect(state.index).toBe(0)
  })
})

describe('moving the selection', () => {
  it('walks the list one row at a time', () => {
    expect(moveSelection({ state: at(1), delta: 1, models: MODELS }).index).toBe(2)
    expect(moveSelection({ state: at(1), delta: -1, models: MODELS }).index).toBe(0)
  })

  it('clamps at both ends rather than wrapping', () => {
    expect(moveSelection({ state: at(4), delta: 1, models: MODELS }).index).toBe(4)
    expect(moveSelection({ state: at(0), delta: -1, models: MODELS }).index).toBe(0)
  })

  it('skips a model with no credential in both directions', () => {
    const availability = new Set(['a', 'c', 'e'])
    expect(moveSelection({ state: at(0), delta: 1, models: MODELS, availability }).index).toBe(2)
    expect(moveSelection({ state: at(2), delta: -1, models: MODELS, availability }).index).toBe(0)
  })

  it('steps over a whole run of models with no credential', () => {
    expect(moveSelection({ state: at(0), delta: 1, models: MODELS, availability: ONLY_ENDS }).index).toBe(4)
    expect(
      moveSelection({ state: at(4), delta: -1, models: MODELS, availability: ONLY_ENDS }).index,
    ).toBe(0)
  })

  it('leaves the highlight alone when every model is unavailable', () => {
    const availability = new Set<string>()
    expect(moveSelection({ state: at(2), delta: 1, models: MODELS, availability }).index).toBe(2)
  })

  it('takes a predicate as readily as a set', () => {
    const availability = (modelId: string): boolean => modelId !== 'b'
    expect(moveSelection({ state: at(0), delta: 1, models: MODELS, availability }).index).toBe(2)
  })

  it('honours a delta larger than one, still clamping', () => {
    expect(moveSelection({ state: at(0), delta: 2, models: MODELS }).index).toBe(2)
    expect(moveSelection({ state: at(0), delta: 9, models: MODELS }).index).toBe(4)
    expect(moveSelection({ state: at(0), delta: 0, models: MODELS }).index).toBe(0)
  })

  it('does not throw on an empty catalog', () => {
    const state = openSwitcher({ models: [], activeModelId: 'a', effort: EEffort.Low })
    expect(state.index).toBe(0)
    expect(moveSelection({ state, delta: 1, models: [] }).index).toBe(0)
    expect(moveSelection({ state, delta: -1, models: [] }).index).toBe(0)
    expect(resolve({ state, models: [] })).toEqual({ modelId: null, effort: EEffort.Low })
  })
})

describe('adjusting the effort', () => {
  it('steps a level at a time', () => {
    expect(adjustEffort({ state: at(0, EEffort.Low), delta: 1 }).effort).toBe(EEffort.Medium)
    expect(adjustEffort({ state: at(0, EEffort.High), delta: -1 }).effort).toBe(EEffort.Medium)
  })

  it('clamps at low and at high', () => {
    expect(adjustEffort({ state: at(0, EEffort.Low), delta: -1 }).effort).toBe(EEffort.Low)
    expect(adjustEffort({ state: at(0, EEffort.High), delta: 1 }).effort).toBe(EEffort.High)
  })

  it('leaves the highlighted row where it was', () => {
    expect(adjustEffort({ state: at(3, EEffort.Low), delta: 1 }).index).toBe(3)
  })
})

describe('resolving what to apply', () => {
  it('names the highlighted model and the pending effort', () => {
    const state = adjustEffort({
      state: moveSelection({ state: at(0, EEffort.Low), delta: 3, models: MODELS }),
      delta: 1,
    })
    expect(resolve({ state, models: MODELS })).toEqual({
      modelId: 'd',
      effort: EEffort.Medium,
    })
  })
})

describe('reading availability', () => {
  it('treats an absent availability as everything keyed', () => {
    expect(isModelAvailable({ modelId: 'anything' })).toBe(true)
  })

  it('reads a set and a predicate the same way', () => {
    expect(isModelAvailable({ modelId: 'b', availability: ONLY_ENDS })).toBe(false)
    expect(isModelAvailable({ modelId: 'b', availability: (id) => id === 'b' })).toBe(true)
  })
})

describe('the price read-out', () => {
  it('spells the output price to the cent', () => {
    expect(priceLabel(entry('a'))).toBe('$5.00/M')
    expect(priceLabel({ ...entry('a'), outputPricePerMillion: 0.8 })).toBe('$0.80/M')
  })
})
