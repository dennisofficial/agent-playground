import type { SharedV4ProviderOptions } from '@ai-sdk/provider'

import { EEffort, EThinkingControl, modelEntry, thinkingBudgetFor } from '@dltech/atlas-core'

/**
 * Anthropic returns a thinking block whose text is empty — signature only — unless the request opts
 * in with `display: "summarized"`. `display` defaults to `"omitted"` on Opus 4.7 and newer, and is
 * only accepted alongside `thinking.type: "adaptive"`, which the models before Sonnet 4.6 reject.
 */
export function anthropicThinkingOptions(args: {
  modelId: string
  effort: EEffort
}): SharedV4ProviderOptions {
  const control = modelEntry(args.modelId)?.thinkingControl ?? EThinkingControl.Effort

  if (control === EThinkingControl.Budget) {
    return { anthropic: { thinking: { type: 'enabled', budgetTokens: thinkingBudgetFor(args.effort) } } }
  }

  return { anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: args.effort } }
}
