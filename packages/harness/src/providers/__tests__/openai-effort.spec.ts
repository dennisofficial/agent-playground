import { describe, expect, it } from 'bun:test'

import { EEffort, EImageTier, type ModelCard } from '@dltech/atlas-core'

import { openaiEffortOptions } from '../openai-effort'

const cardWith = (effort: ModelCard['effort']): ModelCard => ({
  ref: { providerId: 'openai', modelId: 'gpt-5.3-codex' },
  label: 'GPT-5.3 Codex',
  api: 'openai-responses',
  contextWindow: 400_000,
  imageTier: EImageTier.Standard,
  ...(effort === undefined ? {} : { effort }),
})

const CODEX = cardWith({
  [EEffort.Off]: 'none',
  [EEffort.Low]: 'low',
  [EEffort.High]: 'high',
  [EEffort.XHigh]: 'xhigh',
})

const ONE_RUNG = cardWith({ [EEffort.High]: 'high' })

describe('openaiEffortOptions', () => {
  it('names the rung under the openai namespace, not anthropic thinking', () => {
    expect(openaiEffortOptions({ card: CODEX, effort: EEffort.XHigh })).toEqual({
      openai: { reasoningEffort: 'xhigh' },
    })
  })

  it('sends the model its own word for off rather than dropping the parameter', () => {
    expect(openaiEffortOptions({ card: CODEX, effort: EEffort.Off })).toEqual({
      openai: { reasoningEffort: 'none' },
    })
  })

  it('collapses onto the only rung a fixed-effort model offers', () => {
    expect(openaiEffortOptions({ card: ONE_RUNG, effort: EEffort.Low })).toEqual({
      openai: { reasoningEffort: 'high' },
    })
  })

  it('omits the parameter entirely for a model with no reasoning control', () => {
    expect(openaiEffortOptions({ card: cardWith(undefined), effort: EEffort.High })).toBeUndefined()
  })
})
