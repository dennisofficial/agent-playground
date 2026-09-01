import type { SharedV4ProviderOptions } from '@ai-sdk/provider'

import { clampEffort, type EEffort, type ModelCard } from '@dltech/atlas-core'

import { OPENROUTER_PROVIDER_ID } from './openrouter-adapter'

/**
 * OpenRouter's own unified control is `reasoning: { effort }`, but it also accepts OpenAI's
 * `reasoning_effort` for compatibility, which is what @ai-sdk/openai-compatible emits.
 * https://openrouter.ai/docs/use-cases/reasoning-tokens
 */
export function openrouterEffortOptions(args: {
  card: ModelCard
  effort: EEffort
}): SharedV4ProviderOptions | undefined {
  const rung = clampEffort({ map: args.card.effort, effort: args.effort })
  if (rung === undefined) return undefined

  const sent = args.card.effort?.[rung]
  if (typeof sent !== 'string') return undefined

  return { [OPENROUTER_PROVIDER_ID]: { reasoningEffort: sent } }
}
