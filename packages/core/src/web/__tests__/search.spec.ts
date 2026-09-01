import { describe, expect, it } from 'bun:test'

import { BACKEND_TRAITS, EWebSearchBackend, secretNameOf } from '../search'

describe('what a backend needs before it can be asked', () => {
  it('names the secret after the backend, not after a variable', () => {
    expect(secretNameOf(EWebSearchBackend.Tavily)).toBe('search.tavily')
    expect(secretNameOf(EWebSearchBackend.SearXNG)).toBe('search.searxng')
  })

  it('gives every backend a distinct name', () => {
    const names = Object.values(EWebSearchBackend).map(secretNameOf)
    expect(new Set(names).size).toBe(names.length)
  })

  it('leaves the one backend that needs nothing without a field to fill in', () => {
    expect(BACKEND_TRAITS[EWebSearchBackend.DuckDuckGo].keyLabel).toBeUndefined()
    expect(BACKEND_TRAITS[EWebSearchBackend.DuckDuckGo].keyRequired).toBe(false)
  })

  it('asks for a key on every backend that takes one', () => {
    for (const backend of [
      EWebSearchBackend.Jina,
      EWebSearchBackend.Tavily,
      EWebSearchBackend.Exa,
      EWebSearchBackend.Brave,
    ]) {
      expect(BACKEND_TRAITS[backend].keyLabel).toBe('API key')
      expect(BACKEND_TRAITS[backend].masked).toBe(true)
    }
  })

  it('does not mask SearXNG, because what it wants is an address rather than a secret', () => {
    expect(BACKEND_TRAITS[EWebSearchBackend.SearXNG].keyLabel).toBe('Instance URL')
    expect(BACKEND_TRAITS[EWebSearchBackend.SearXNG].masked).toBe(false)
  })

  it('records that only Jina works without the key it can take', () => {
    expect(BACKEND_TRAITS[EWebSearchBackend.Jina].keyRequired).toBe(false)
    expect(BACKEND_TRAITS[EWebSearchBackend.Tavily].keyRequired).toBe(true)
  })

  it('mentions no environment variable anywhere, because none is read', () => {
    const written = JSON.stringify(BACKEND_TRAITS)
    expect(written).not.toContain('_API_KEY')
    expect(written).not.toContain('ATLAS_')
  })
})
