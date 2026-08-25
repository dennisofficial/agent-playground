import { describe, expect, it } from 'bun:test'

import { carriedProviderOptions, mergeProviderOptions, toCoreProviderOptions } from '../provider-options'

describe('mergeProviderOptions', () => {
  it('returns the incoming options when there is no base', () => {
    expect(mergeProviderOptions({ base: undefined, incoming: { anthropic: { signature: 'sig-abc' } } })).toEqual({
      anthropic: { signature: 'sig-abc' },
    })
  })

  it('returns the base when nothing arrives', () => {
    expect(mergeProviderOptions({ base: { anthropic: { signature: 'sig-abc' } }, incoming: undefined })).toEqual({
      anthropic: { signature: 'sig-abc' },
    })
  })

  it('is undefined when neither side carries anything', () => {
    expect(mergeProviderOptions({ base: undefined, incoming: undefined })).toBeUndefined()
  })

  it('keeps keys from both sides of the same namespace', () => {
    const merged = mergeProviderOptions({
      base: { anthropic: { redactedThinking: 'yes' } },
      incoming: { anthropic: { signature: 'sig-abc' } },
    })

    expect(merged).toEqual({ anthropic: { redactedThinking: 'yes', signature: 'sig-abc' } })
  })

  it('keeps a namespace only one side carries', () => {
    const merged = mergeProviderOptions({
      base: { anthropic: { signature: 'sig-abc' } },
      incoming: { openai: { itemId: 'rs_1' } },
    })

    expect(merged).toEqual({ anthropic: { signature: 'sig-abc' }, openai: { itemId: 'rs_1' } })
  })

  it('lets the later value win on a key collision', () => {
    const merged = mergeProviderOptions({
      base: { anthropic: { signature: 'partial' } },
      incoming: { anthropic: { signature: 'sig-abc' } },
    })

    expect(merged).toEqual({ anthropic: { signature: 'sig-abc' } })
  })

  it('does not mutate either side', () => {
    const base = { anthropic: { redactedThinking: 'yes' } }
    const incoming = { anthropic: { signature: 'sig-abc' } }

    mergeProviderOptions({ base, incoming })

    expect(base).toEqual({ anthropic: { redactedThinking: 'yes' } })
    expect(incoming).toEqual({ anthropic: { signature: 'sig-abc' } })
  })
})

describe('toCoreProviderOptions', () => {
  it('is undefined for absent metadata', () => {
    expect(toCoreProviderOptions(undefined)).toBeUndefined()
  })

  it('drops the undefined values the provider JSON type permits', () => {
    expect(toCoreProviderOptions({ anthropic: { signature: 'sig-abc', absent: undefined } })).toEqual({
      anthropic: { signature: 'sig-abc' },
    })
  })

  it('drops undefined values nested inside a namespace value', () => {
    expect(toCoreProviderOptions({ anthropic: { detail: { kept: 1, absent: undefined } } })).toEqual({
      anthropic: { detail: { kept: 1 } },
    })
  })

  it('preserves arrays and scalars', () => {
    expect(toCoreProviderOptions({ openai: { ids: ['a', 'b'], depth: 2, on: true, none: null } })).toEqual({
      openai: { ids: ['a', 'b'], depth: 2, on: true, none: null },
    })
  })
})

describe('carriedProviderOptions', () => {
  it('carries nothing when there are no options, so the key never appears', () => {
    expect(Object.keys({ ...carriedProviderOptions(undefined) })).toEqual([])
  })

  it('carries the options under the request-side name', () => {
    expect(carriedProviderOptions({ anthropic: { signature: 'sig-abc' } })).toEqual({
      providerOptions: { anthropic: { signature: 'sig-abc' } },
    })
  })
})
