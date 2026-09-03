import { DEFAULT_IMAGE_TIER, EImageTier } from '@dltech/atlas-core'
import { RELEASE_STAMP, type GeneratedCard } from '../src/models/generated-card'

export enum ESkipReason {
  UnmappedNpm = 'provider npm has no api mapping',
  Deprecated = 'status is deprecated',
  NoToolCall = 'tool_call is not true',
  NoContextWindow = 'limit.context is missing',
  NoChatEndpoint = 'supported_endpoints omits chat',
}

export enum ENote {
  CostMissing = 'cost omitted (the source has no price)',
  EffortBudget = 'effort mapped to a thinking-token budget',
  EffortUnmapped = 'effort omitted (reasoning offers no mappable ladder)',
  NoReasoningControl = 'effort omitted (model declares no reasoning)',
  ImageTierDefaulted = 'imageTier defaulted (not on the high-resolution list)',
}

export type ProviderReport = {
  providerId: string
  api: string | undefined
  kept: number
  skipped: Partial<Record<ESkipReason, number>>
  notes: Partial<Record<ENote, number>>
}

export type ProviderMapping = {
  cards: readonly GeneratedCard[]
  report: ProviderReport
}

/**
 * The tier a model reads an image at is a per-model fact rather than a version rule, and neither
 * models.dev nor inference.net carries a tier at all, so this list is hand-maintained and
 * everything absent from it falls back to DEFAULT_IMAGE_TIER.
 * https://platform.claude.com/docs/en/build-with-claude/vision
 */
const HIGH_RESOLUTION_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-fable-5-1',
])

export const readsHighResolution = (modelId: string): boolean =>
  HIGH_RESOLUTION_MODELS.has(modelId) ||
  HIGH_RESOLUTION_MODELS.has(modelId.replace(RELEASE_STAMP, ''))

export const imageTierFor = (modelId: string): EImageTier =>
  readsHighResolution(modelId) ? EImageTier.HighResolution : DEFAULT_IMAGE_TIER

export const tally = <T extends string>({
  counts,
  key,
}: {
  counts: Partial<Record<T, number>>
  key: T
}): void => {
  counts[key] = (counts[key] ?? 0) + 1
}
