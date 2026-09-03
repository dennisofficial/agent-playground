import { API_BY_NPM, type GeneratedCard } from '../src/models/generated-card'
import {
  ENote,
  ESkipReason,
  imageTierFor,
  readsHighResolution,
  tally,
  type ProviderMapping,
  type ProviderReport,
} from './catalogue-report'
import { deriveEffort, EEffortShape } from './catalogue-effort'
import type { ModelsDevModel, ModelsDevProvider } from './models-dev'

const NOTE_BY_EFFORT_SHAPE: Readonly<Record<EEffortShape, ENote | undefined>> = {
  [EEffortShape.Literals]: undefined,
  [EEffortShape.Budget]: ENote.EffortBudget,
  [EEffortShape.Unmapped]: ENote.EffortUnmapped,
  [EEffortShape.None]: ENote.NoReasoningControl,
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
