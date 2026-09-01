import { describe, expect, it } from 'bun:test'
import * as harness from '../../index'

describe('harness barrel', () => {
  it('reaches the generated catalogue from the package root', () => {
    expect(typeof harness.generatedCatalogue).toBe('function')
    expect(typeof harness.generatedCards).toBe('function')
    expect(typeof harness.cardsForProvider).toBe('function')
    expect(typeof harness.withoutDatedDuplicates).toBe('function')
    expect(harness.GENERATED_MANIFEST.source).toBe('models.dev')
  })

  it('resolves the same catalogue through the barrel as through the module', () => {
    expect(harness.cardsForProvider('anthropic').length).toBeGreaterThan(0)
    expect(harness.generatedCatalogue().size).toBe(harness.GENERATED_MANIFEST.modelCount)
  })
})
