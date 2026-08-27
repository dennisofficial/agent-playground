import { describe, expect, it } from 'bun:test'

import { EEffort, thinkingBudgetFor } from '@dltech/atlas-core'

import { anthropicThinkingOptions } from '../anthropic-thinking'

describe('anthropicThinkingOptions', () => {
  it('opts a model that would otherwise omit its thinking into a summarized display', () => {
    expect(anthropicThinkingOptions({ modelId: 'claude-opus-5', effort: EEffort.High })).toEqual({
      anthropic: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: EEffort.High,
      },
    })
  })

  it('carries the effort a stamped release id resolves to the same catalog entry', () => {
    expect(anthropicThinkingOptions({ modelId: 'claude-sonnet-5', effort: EEffort.Low })).toEqual(
      anthropicThinkingOptions({ modelId: 'claude-sonnet-5-20260101', effort: EEffort.Low }),
    )
  })

  it('asks a budget-controlled model for a token budget, which is all it accepts', () => {
    expect(anthropicThinkingOptions({ modelId: 'claude-haiku-4-5', effort: EEffort.Medium })).toEqual({
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: thinkingBudgetFor(EEffort.Medium) },
      },
    })
  })

  it('treats a model outside the catalog as effort-controlled', () => {
    expect(anthropicThinkingOptions({ modelId: 'claude-opus-9', effort: EEffort.High })).toEqual({
      anthropic: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: EEffort.High,
      },
    })
  })
})
