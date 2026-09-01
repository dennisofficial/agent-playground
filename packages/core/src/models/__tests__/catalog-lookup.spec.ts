import { describe, expect, it } from 'bun:test'

import { EImageTier } from '../../images/projection'
import { catalogOf, findCard, type ModelCard } from '../card'
import { EEffort } from '../effort-ladder'

const OPUS_ON_THE_PLAN: ModelCard = {
  ref: { providerId: 'anthropic', modelId: 'claude-opus-5' },
  label: 'opus-5',
  api: 'anthropic-messages',
  contextWindow: 1_000_000,
  imageTier: EImageTier.HighResolution,
  effort: { [EEffort.High]: 'high', [EEffort.XHigh]: 'xhigh', [EEffort.Max]: 'max' },
}

const OPUS_THROUGH_OPENROUTER: ModelCard = {
  ref: { providerId: 'openrouter', modelId: 'anthropic/claude-opus-5' },
  label: 'opus-5',
  api: 'openai-completions',
  contextWindow: 200_000,
  imageTier: EImageTier.HighResolution,
  cost: { inputPerMillion: 5, outputPerMillion: 25 },
  effort: { [EEffort.Low]: 'low', [EEffort.High]: 'high' },
}

const CATALOG = catalogOf([OPUS_ON_THE_PLAN, OPUS_THROUGH_OPENROUTER])

describe('findCard', () => {
  it('keeps one model reached two ways as two cards', () => {
    expect(CATALOG.size).toBe(2)
  })

  it('resolves each provider to its own facts about the same model', () => {
    const onThePlan = findCard({ catalog: CATALOG, ref: OPUS_ON_THE_PLAN.ref })
    const throughOpenRouter = findCard({ catalog: CATALOG, ref: OPUS_THROUGH_OPENROUTER.ref })

    expect(onThePlan?.cost).toBeUndefined()
    expect(throughOpenRouter?.cost).toEqual({ inputPerMillion: 5, outputPerMillion: 25 })
    expect(onThePlan?.contextWindow).toBe(1_000_000)
    expect(throughOpenRouter?.contextWindow).toBe(200_000)
  })

  it('does not find a model under a provider that does not serve it', () => {
    expect(
      findCard({ catalog: CATALOG, ref: { providerId: 'anthropic', modelId: 'gpt-5-codex' } }),
    ).toBeUndefined()
  })
})
