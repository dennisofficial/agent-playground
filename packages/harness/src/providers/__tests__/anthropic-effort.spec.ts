import { describe, expect, it } from 'bun:test'

import { EEffort, EImageTier, type ModelCard } from '@dltech/atlas-core'

import { anthropicEffortOptions } from '../anthropic-effort'

const cardWith = (effort: ModelCard['effort']): ModelCard => ({
  ref: { providerId: 'anthropic', modelId: 'claude-opus-5' },
  label: 'opus-5',
  api: 'anthropic-messages',
  contextWindow: 1_000_000,
  imageTier: EImageTier.HighResolution,
  ...(effort === undefined ? {} : { effort }),
})

const ADAPTIVE = cardWith({
  [EEffort.Low]: 'low',
  [EEffort.High]: 'high',
  [EEffort.XHigh]: 'xhigh',
})

const BUDGETED = cardWith({ [EEffort.Low]: 1024, [EEffort.Medium]: 2048 })

describe('anthropicEffortOptions', () => {
  it('sends the rung the model names, not the rung the picker calls it', () => {
    expect(anthropicEffortOptions({ card: ADAPTIVE, effort: EEffort.XHigh })).toEqual({
      anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'xhigh' },
    })
  })

  it('asks a budget-controlled model for tokens, which is all it accepts', () => {
    expect(anthropicEffortOptions({ card: BUDGETED, effort: EEffort.Medium })).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } },
    })
  })

  it('lands on a rung the model has when asked for one it does not', () => {
    expect(anthropicEffortOptions({ card: ADAPTIVE, effort: EEffort.Max })).toEqual({
      anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'xhigh' },
    })
  })

  it('says nothing at all about thinking for a model that cannot do it', () => {
    expect(
      anthropicEffortOptions({ card: cardWith(undefined), effort: EEffort.High }),
    ).toBeUndefined()
  })
})
