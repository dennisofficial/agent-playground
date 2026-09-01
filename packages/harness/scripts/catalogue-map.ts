import { DEFAULT_IMAGE_TIER, EImageTier } from '@dltech/atlas-core'
import { API_BY_NPM, RELEASE_STAMP, type GeneratedCard } from '../src/models/generated-card'
import { deriveEffort, EEffortShape } from './catalogue-effort'
import type { ModelsDevModel, ModelsDevProvider } from './models-dev'

export enum ESkipReason {
  UnmappedNpm = 'provider npm has no api mapping',
  Deprecated = 'status is deprecated',
  NoToolCall = 'tool_call is not true',
  NoContextWindow = 'limit.context is missing',
}

export enum ENote {
  CostMissing = 'cost omitted (models.dev has no price)',
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
 * The tier a model reads an image at is a per-model fact rather than a version rule, and models.dev
 * carries no tier at all, so this list is hand-maintained and everything absent from it falls back
 * to DEFAULT_IMAGE_TIER. https://platform.claude.com/docs/en/build-with-claude/vision
 */
const HIGH_RESOLUTION_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-fable-5-1',
])

const readsHighResolution = (modelId: string): boolean =>
  HIGH_RESOLUTION_MODELS.has(modelId) ||
  HIGH_RESOLUTION_MODELS.has(modelId.replace(RELEASE_STAMP, ''))

const imageTierFor = (modelId: string): EImageTier =>
  readsHighResolution(modelId) ? EImageTier.HighResolution : DEFAULT_IMAGE_TIER

const NOTE_BY_EFFORT_SHAPE: Readonly<Record<EEffortShape, ENote | undefined>> = {
  [EEffortShape.Literals]: undefined,
  [EEffortShape.Budget]: ENote.EffortBudget,
  [EEffortShape.Unmapped]: ENote.EffortUnmapped,
  [EEffortShape.None]: ENote.NoReasoningControl,
}

const tally = <T extends string>({
  counts,
  key,
}: {
  counts: Partial<Record<T, number>>
  key: T
}): void => {
  counts[key] = (counts[key] ?? 0) + 1
}

function cardFor({
  model,
  modelId,
  providerId,
  api,
}: {
  model: ModelsDevModel
  modelId: string
  providerId: string
  api: string
}): GeneratedCard | undefined {
  const contextWindow = model.limit?.context
  if (contextWindow === undefined || contextWindow <= 0) return undefined

  const maxOutputTokens = model.limit?.output
  const input = model.cost?.input
  const output = model.cost?.output
  const effort = deriveEffort(model).rungs

  return {
    ref: { providerId, modelId },
    label: model.name ?? modelId,
    api,
    contextWindow,
    imageTier: imageTierFor(modelId),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(input === undefined || output === undefined
      ? {}
      : { cost: { inputPerMillion: input, outputPerMillion: output } }),
    ...(effort === undefined ? {} : { effort }),
  }
}

function noteCard({
  card,
  model,
  notes,
}: {
  card: GeneratedCard
  model: ModelsDevModel
  notes: Partial<Record<ENote, number>>
}): void {
  if (card.cost === undefined) tally({ counts: notes, key: ENote.CostMissing })
  if (!readsHighResolution(card.ref.modelId)) {
    tally({ counts: notes, key: ENote.ImageTierDefaulted })
  }

  const shaped = NOTE_BY_EFFORT_SHAPE[deriveEffort(model).shape]
  if (shaped !== undefined) tally({ counts: notes, key: shaped })
}

export function mapProvider({
  providerId,
  provider,
}: {
  providerId: string
  provider: ModelsDevProvider
}): ProviderMapping {
  const skipped: Partial<Record<ESkipReason, number>> = {}
  const notes: Partial<Record<ENote, number>> = {}
  const api = provider.npm === undefined ? undefined : API_BY_NPM[provider.npm]

  if (api === undefined) {
    skipped[ESkipReason.UnmappedNpm] = Object.keys(provider.models).length
    return { cards: [], report: { providerId, api, kept: 0, skipped, notes } }
  }

  const cards: GeneratedCard[] = []
  for (const modelId of Object.keys(provider.models).sort()) {
    const model = provider.models[modelId]
    if (model === undefined) continue

    if (model.status === 'deprecated') {
      tally({ counts: skipped, key: ESkipReason.Deprecated })
      continue
    }
    if (model.tool_call !== true) {
      tally({ counts: skipped, key: ESkipReason.NoToolCall })
      continue
    }

    const card = cardFor({ model, modelId, providerId, api })
    if (card === undefined) {
      tally({ counts: skipped, key: ESkipReason.NoContextWindow })
      continue
    }

    noteCard({ card, model, notes })
    cards.push(card)
  }

  return { cards, report: { providerId, api, kept: cards.length, skipped, notes } }
}
