import { describe, expect, it } from 'bun:test'

import { EEffort, EImageTier, type ModelCard } from '@dltech/atlas-core'

import { OPENROUTER_PROVIDER_ID } from '../openrouter-adapter'
import { openrouterEffortOptions } from '../openrouter-effort'

const cardWith = (effort: ModelCard['effort']): ModelCard => ({
  ref: { providerId: OPENROUTER_PROVIDER_ID, modelId: 'moonshotai/kimi-k3' },
  label: 'Kimi K3',
  api: 'openai-completions',
  contextWindow: 1_048_576,
  imageTier: EImageTier.Standard,
  ...(effort === undefined ? {} : { effort }),
})

const KIMI = cardWith({ [EEffort.Low]: 'low', [EEffort.High]: 'high', [EEffort.Max]: 'max' })

describe('openrouterEffortOptions', () => {
  it('names the rung under the openrouter namespace the compatible provider reads', () => {
    expect(openrouterEffortOptions({ card: KIMI, effort: EEffort.Max })).toEqual({
      [OPENROUTER_PROVIDER_ID]: { reasoningEffort: 'max' },
    })
  })

  it('skips a rung the model omits rather than inventing one between', () => {
    expect(openrouterEffortOptions({ card: KIMI, effort: EEffort.Medium })).toEqual({
      [OPENROUTER_PROVIDER_ID]: { reasoningEffort: 'high' },
    })
  })

  it('says nothing for a model that declares no reasoning at all', () => {
    expect(openrouterEffortOptions({ card: cardWith(undefined), effort: EEffort.High })).toBeUndefined()
  })
})
