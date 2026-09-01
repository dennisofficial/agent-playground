import { describe, expect, it } from 'bun:test'

import { EImageTier } from '../../images/projection'
import { EModelVendor } from '../catalog'
import { MODEL_CATALOG, imageTierFor, modelEntry } from '../registry'

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

describe('imageTierFor', () => {
  it('reads Claude 4.7 and later at the high-resolution tier', () => {
    expect(imageTierFor('claude-opus-5')).toBe(EImageTier.HighResolution)
    expect(imageTierFor('claude-sonnet-5')).toBe(EImageTier.HighResolution)
  })

  it('reads an earlier Claude at the standard tier, where the same picture costs a third', () => {
    expect(imageTierFor('claude-haiku-4-5')).toBe(EImageTier.Standard)
  })

  it('follows a release stamp back to the model it names', () => {
    expect(imageTierFor('claude-haiku-4-5-20251001')).toBe(EImageTier.Standard)
  })

  it('assumes the dearer tier for a model it has never heard of, so the meter cannot run short', () => {
    expect(imageTierFor('some-unreleased-model')).toBe(EImageTier.HighResolution)
  })
})
