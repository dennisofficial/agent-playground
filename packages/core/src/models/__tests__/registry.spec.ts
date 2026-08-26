import { describe, expect, it } from 'bun:test'

import { EModelVendor } from '../catalog'
import { MODEL_CATALOG, modelEntry } from '../registry'

describe('MODEL_CATALOG', () => {
  it('names every model once', () => {
    expect(new Set(MODEL_CATALOG.map((entry) => entry.id)).size).toBe(MODEL_CATALOG.length)
  })

  it('carries a window and a price for every model', () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.contextWindow).toBeGreaterThan(0)
      expect(entry.inputPricePerMillion).toBeGreaterThan(0)
      expect(entry.outputPricePerMillion).toBeGreaterThan(0)
    }
  })

  it('holds both vendors the app can talk to', () => {
    expect(new Set(MODEL_CATALOG.map((entry) => entry.vendor))).toEqual(
      new Set([EModelVendor.Anthropic, EModelVendor.OpenAI]),
    )
  })
})

describe('modelEntry', () => {
  it('finds a model by its exact id', () => {
    expect(modelEntry('claude-opus-5')?.label).toBe('opus-5')
  })

  it('finds a model behind a release stamp', () => {
    expect(modelEntry('claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5')
  })

  it('does not mistake a version suffix for a release stamp', () => {
    expect(modelEntry('claude-haiku-4-5-2025')).toBeUndefined()
  })

  it('knows nothing about a model it was never given', () => {
    expect(modelEntry('gpt-4o')).toBeUndefined()
    expect(modelEntry('')).toBeUndefined()
  })
})
