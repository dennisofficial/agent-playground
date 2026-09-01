import type { SharedV4ProviderOptions } from '@ai-sdk/provider'

import { clampEffort, type EEffort, type ModelCard } from '@dltech/atlas-core'

/**
 * OpenAI spells "do not reason" as a rung named `none` rather than as an absent parameter, and
 * which rungs exist varies per model: gpt-5-pro accepts only `high`, and o1-mini rejects the
 * parameter outright. https://platform.openai.com/docs/guides/reasoning
 */
export function openaiEffortOptions(args: {
  card: ModelCard
  effort: EEffort
}): SharedV4ProviderOptions | undefined {
  const rung = clampEffort({ map: args.card.effort, effort: args.effort })
  if (rung === undefined) return undefined

  const sent = args.card.effort?.[rung]
  if (typeof sent !== 'string') return undefined

  return { openai: { reasoningEffort: sent } }
}
