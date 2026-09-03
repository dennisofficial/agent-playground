import type { SharedV4ProviderOptions } from '@ai-sdk/provider'

import { clampEffort, type EEffort, type ModelCard } from '@dltech/atlas-core'

import { INFERENCE_PROVIDER_ID } from './inference-adapter'

/**
 * inference.net publishes each model's accepted rungs as `reasoning_efforts` on /v1/models and
 * takes the chosen one as OpenAI's `reasoning_effort`, which is what @ai-sdk/openai-compatible
 * emits. https://docs.inference.net/api/api-quickstart
 */
export function inferenceEffortOptions(args: {
  card: ModelCard
  effort: EEffort
}): SharedV4ProviderOptions | undefined {
  const rung = clampEffort({ map: args.card.effort, effort: args.effort })
  if (rung === undefined) return undefined

  const sent = args.card.effort?.[rung]
  if (typeof sent !== 'string') return undefined

  return { [INFERENCE_PROVIDER_ID]: { reasoningEffort: sent } }
}
