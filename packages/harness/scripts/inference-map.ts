import {
  INFERENCE_CATALOGUE_PROVIDER_ID,
  OPENAI_COMPLETIONS_API,
  type GeneratedCard,
} from '../src/models/generated-card'
import { literalRungs } from './catalogue-effort'
import {
  ENote,
  ESkipReason,
  imageTierFor,
  readsHighResolution,
  tally,
  type ProviderMapping,
} from './catalogue-report'
import type { InferenceModel } from './inference-net'

/**
 * inference.net fronts three wire protocols on one host and says which per model. Only `chat`
 * is OpenAI chat-completions, which is the shape the openai-compatible adapter speaks; `messages`
 * is Anthropic's and `responses` is OpenAI's, and both reject a chat-completions body.
 * https://docs.inference.net/api/api-quickstart
 */
const CHAT_ENDPOINT = 'chat'

const PER_MILLION = 1_000_000

/**
 * inference.net prices per token as a decimal string of twelve places, so scaling to a
 * per-million figure lands on binary-float noise like 2.0999999999999996 unless it is rounded.
 */
const PRICE_PRECISION = 1_000_000

function perMillion(price: string | undefined): number | undefined {
  if (price === undefined) return undefined

  const perToken = Number(price)
  if (!Number.isFinite(perToken)) return undefined
  return Math.round(perToken * PER_MILLION * PRICE_PRECISION) / PRICE_PRECISION
}

function cardFor(model: InferenceModel): GeneratedCard | undefined {
  const contextWindow = model.context_length
  if (contextWindow === undefined || contextWindow <= 0) return undefined

  const maxOutputTokens = model.max_completion_tokens
  const inputPerMillion = perMillion(model.pricing?.prompt)
  const outputPerMillion = perMillion(model.pricing?.completion)
  const effort = literalRungs(model.reasoning_efforts ?? [])

  return {
    ref: { providerId: INFERENCE_CATALOGUE_PROVIDER_ID, modelId: model.id },
    label: model.id,
    api: OPENAI_COMPLETIONS_API,
    contextWindow,
    imageTier: imageTierFor(model.id),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(inputPerMillion === undefined || outputPerMillion === undefined
      ? {}
      : { cost: { inputPerMillion, outputPerMillion } }),
    ...(effort === undefined ? {} : { effort }),
  }
}

function noteCard({
  card,
  notes,
}: {
  card: GeneratedCard
  notes: Partial<Record<ENote, number>>
}): void {
  if (card.cost === undefined) tally({ counts: notes, key: ENote.CostMissing })
  if (!readsHighResolution(card.ref.modelId)) {
    tally({ counts: notes, key: ENote.ImageTierDefaulted })
  }
  if (card.effort === undefined) tally({ counts: notes, key: ENote.NoReasoningControl })
}

export function mapInferenceModels(models: readonly InferenceModel[]): ProviderMapping {
  const skipped: Partial<Record<ESkipReason, number>> = {}
  const notes: Partial<Record<ENote, number>> = {}

  const cards: GeneratedCard[] = []
  for (const model of [...models].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!(model.supported_endpoints ?? []).includes(CHAT_ENDPOINT)) {
      tally({ counts: skipped, key: ESkipReason.NoChatEndpoint })
      continue
    }

    const card = cardFor(model)
    if (card === undefined) {
      tally({ counts: skipped, key: ESkipReason.NoContextWindow })
      continue
    }

    noteCard({ card, notes })
    cards.push(card)
  }

  return {
    cards,
    report: {
      providerId: INFERENCE_CATALOGUE_PROVIDER_ID,
      api: OPENAI_COMPLETIONS_API,
      kept: cards.length,
      skipped,
      notes,
    },
  }
}
