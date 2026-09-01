import type { SharedV4ProviderOptions } from '@ai-sdk/provider'

import { clampEffort, type EEffort, type ModelCard } from '@dltech/atlas-core'

/**
 * Anthropic returns a thinking block whose text is empty — signature only — unless the request opts
 * in with `display: "summarized"`. `display` defaults to `"omitted"` on Opus 4.7 and newer, and is
 * only accepted alongside `thinking.type: "adaptive"`, which the models before Sonnet 4.6 reject in
 * favour of a token budget.
 */
export function anthropicEffortOptions(args: {
  card: ModelCard
  effort: EEffort
}): SharedV4ProviderOptions | undefined {
  const rung = clampEffort({ map: args.card.effort, effort: args.effort })
  if (rung === undefined) return undefined

  const sent = args.card.effort?.[rung]
  if (sent === undefined) return undefined

  if (typeof sent === 'number') {
    return { anthropic: { thinking: { type: 'enabled', budgetTokens: sent } } }
  }

  return { anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: sent } }
}
