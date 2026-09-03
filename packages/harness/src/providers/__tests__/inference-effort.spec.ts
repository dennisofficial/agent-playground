import { describe, expect, it } from 'bun:test'

import { EEffort, EImageTier, type ModelCard } from '@dltech/atlas-core'

import { INFERENCE_PROVIDER_ID } from '../inference-adapter'
import { inferenceEffortOptions } from '../inference-effort'

const cardWith = (effort: ModelCard['effort']): ModelCard => ({
  ref: { providerId: INFERENCE_PROVIDER_ID, modelId: 'gpt-5.6-terra' },
  label: 'gpt-5.6-terra',
  api: 'openai-completions',
  contextWindow: 1_050_000,
  imageTier: EImageTier.Standard,
  ...(effort === undefined ? {} : { effort }),
})

const TERRA = cardWith({
  [EEffort.Off]: 'none',
  [EEffort.Minimal]: 'minimal',
  [EEffort.Low]: 'low',
  [EEffort.Medium]: 'medium',
  [EEffort.High]: 'high',
  [EEffort.XHigh]: 'xhigh',
})

describe('inferenceEffortOptions', () => {
  it('names the rung under the inference namespace the compatible provider reads', () => {
    expect(inferenceEffortOptions({ card: TERRA, effort: EEffort.High })).toEqual({
      [INFERENCE_PROVIDER_ID]: { reasoningEffort: 'high' },
    })
  })

  it("sends none for the off rung, which is the literal inference.net's catalogue offers", () => {
    expect(inferenceEffortOptions({ card: TERRA, effort: EEffort.Off })).toEqual({
      [INFERENCE_PROVIDER_ID]: { reasoningEffort: 'none' },
    })
  })

  it('falls back to the top rung a model does offer rather than inventing one', () => {
    expect(inferenceEffortOptions({ card: TERRA, effort: EEffort.Max })).toEqual({
      [INFERENCE_PROVIDER_ID]: { reasoningEffort: 'xhigh' },
    })
  })

  it('skips a rung the model omits rather than inventing one between', () => {
    const kimi = cardWith({ [EEffort.Low]: 'low', [EEffort.High]: 'high' })

    expect(inferenceEffortOptions({ card: kimi, effort: EEffort.Medium })).toEqual({
      [INFERENCE_PROVIDER_ID]: { reasoningEffort: 'high' },
    })
  })

  it('says nothing for a model that declares no reasoning at all', () => {
    expect(
      inferenceEffortOptions({ card: cardWith(undefined), effort: EEffort.High }),
    ).toBeUndefined()
  })
})
