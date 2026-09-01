import { describe, expect, it } from 'bun:test'

import { parseRef, refKey } from '../ref'

describe('parseRef', () => {
  it('splits a reference on its first slash', () => {
    expect(parseRef('anthropic/claude-opus-5')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
    })
  })

  it('keeps later slashes with the model, so a routed id survives', () => {
    expect(parseRef('openrouter/anthropic/claude-opus-4.5')).toEqual({
      providerId: 'openrouter',
      modelId: 'anthropic/claude-opus-4.5',
    })
  })

  it('refuses a reference that names no provider', () => {
    expect(parseRef('claude-opus-5')).toBeUndefined()
  })

  it('refuses a reference whose halves are not both present', () => {
    expect(parseRef('anthropic/')).toBeUndefined()
    expect(parseRef('/claude-opus-5')).toBeUndefined()
  })
})

describe('refKey', () => {
  it('rejoins what parseRef split', () => {
    const reference = 'openrouter/anthropic/claude-opus-4.5'
    const parsed = parseRef(reference)

    expect(parsed).toBeDefined()
    expect(refKey(parsed!)).toBe(reference)
  })
})
