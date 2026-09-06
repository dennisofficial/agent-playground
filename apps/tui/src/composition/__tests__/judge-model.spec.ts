import { describe, expect, it } from 'bun:test'

import {
  EUtilityModelRole,
  UTILITY_MODEL_DEFAULTS,
  type CredentialPort,
} from '@dltech/atlas-core'

import { judgeModel, judgeRefFor } from '../judge-model'

const credentials: CredentialPort = {
  read: () => Promise.reject(new Error('no credential in this spec')),
  discard: () => Promise.resolve(),
}

const judgeDefault = UTILITY_MODEL_DEFAULTS[EUtilityModelRole.Judge]

describe('judgeRefFor', () => {
  it('falls back to the registry default when no quick model is set', () => {
    expect(judgeRefFor({ override: '' })).toEqual(judgeDefault)
  })

  it('honours a quick-model override that names a real card', () => {
    expect(judgeRefFor({ override: 'openai/gpt-4.1-mini' })).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
    })
  })

  it('falls back to the default when the override names no card', () => {
    expect(judgeRefFor({ override: 'openai/gpt-nope' })).toEqual(judgeDefault)
  })
})

describe('judgeModel', () => {
  it('builds the default through the anthropic adapter', () => {
    const model = judgeModel({ ref: judgeRefFor({ override: '' }), credentials })

    expect(model.provider).toBe(judgeDefault.providerId)
    expect(model.modelId).toBe(judgeDefault.modelId)
  })

  it('builds an override through its own provider adapter', () => {
    const model = judgeModel({
      ref: { providerId: 'openai', modelId: 'gpt-4.1-mini' },
      credentials,
    })

    expect(model.provider).toBe('openai')
    expect(model.modelId).toBe('gpt-4.1-mini')
  })

  it('refuses a provider no adapter answers for', () => {
    expect(() =>
      judgeModel({ ref: { providerId: 'nobody', modelId: 'nothing' }, credentials }),
    ).toThrow('no provider adapter can answer for nobody/nothing')
  })

  it('refuses a model the provider does not carry', () => {
    expect(() =>
      judgeModel({ ref: { providerId: 'anthropic', modelId: 'claude-nope' }, credentials }),
    ).toThrow('no provider adapter can answer for anthropic/claude-nope')
  })
})
