import {
  EEffort,
  EFFORT_LADDER,
  EImageTier,
  type EffortMap,
  type ModelCard,
  type ModelCost,
} from '@dltech/atlas-core'

export const CATALOGUE_PROVIDER_IDS: readonly string[] = [
  'anthropic',
  'openai',
  'openrouter',
  'inference',
]

/**
 * Anthropic and OpenAI both publish a floating alias beside dated snapshots of the same model, and
 * they punctuate the date differently: `claude-haiku-4-5-20251001` against `gpt-4o-2024-08-06`.
 */
export const RELEASE_STAMP = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/

export const API_BY_NPM: Readonly<Record<string, string>> = {
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/openai-compatible': 'openai-completions',
  '@openrouter/ai-sdk-provider': 'openai-completions',
}

export type GeneratedCard = {
  ref: { providerId: string; modelId: string }
  label: string
  api: string
  contextWindow: number
  imageTier: string
  maxOutputTokens?: number
  cost?: { inputPerMillion: number; outputPerMillion: number }
  effort?: Record<string, string | number>
}

export type GeneratedManifest = {
  generatedAt: string
  source: string
  providerCount: number
  modelCount: number
  hash: string
}

const IMAGE_TIER_BY_ID: Readonly<Record<string, EImageTier>> = {
  [EImageTier.Standard]: EImageTier.Standard,
  [EImageTier.HighResolution]: EImageTier.HighResolution,
}

const EFFORT_BY_ID: Readonly<Record<string, EEffort>> = Object.fromEntries(
  EFFORT_LADDER.map((effort) => [effort, effort]),
)

function toCost(cost: GeneratedCard['cost']): ModelCost | undefined {
  if (cost === undefined) return undefined
  return { inputPerMillion: cost.inputPerMillion, outputPerMillion: cost.outputPerMillion }
}

function toEffortMap(effort: GeneratedCard['effort']): EffortMap | undefined {
  if (effort === undefined) return undefined

  const map: EffortMap = {}
  for (const [rung, wire] of Object.entries(effort)) {
    const known = EFFORT_BY_ID[rung]
    if (known === undefined) continue
    map[known] = wire
  }

  return Object.keys(map).length === 0 ? undefined : map
}

export function toModelCard(row: GeneratedCard): ModelCard | undefined {
  const imageTier = IMAGE_TIER_BY_ID[row.imageTier]
  if (imageTier === undefined) return undefined

  const cost = toCost(row.cost)
  const effort = toEffortMap(row.effort)

  return {
    ref: { providerId: row.ref.providerId, modelId: row.ref.modelId },
    label: row.label,
    api: row.api,
    contextWindow: row.contextWindow,
    imageTier,
    ...(row.maxOutputTokens === undefined ? {} : { maxOutputTokens: row.maxOutputTokens }),
    ...(cost === undefined ? {} : { cost }),
    ...(effort === undefined ? {} : { effort }),
  }
}
