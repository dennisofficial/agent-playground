import { catalogOf, refKey, type ModelCard, type ModelCatalog } from '@dltech/atlas-core'
import anthropicRows from './generated/anthropic.json'
import inferenceRows from './generated/inference.json'
import manifestRow from './generated/manifest.json'
import openaiRows from './generated/openai.json'
import openrouterRows from './generated/openrouter.json'
import {
  RELEASE_STAMP,
  toModelCard,
  type GeneratedCard,
  type GeneratedManifest,
} from './generated-card'

const SOURCES: readonly (readonly GeneratedCard[])[] = [
  anthropicRows,
  openaiRows,
  openrouterRows,
  inferenceRows,
]

export const GENERATED_MANIFEST: GeneratedManifest = manifestRow

export const generatedCards = (): readonly ModelCard[] => {
  const cards: ModelCard[] = []
  for (const rows of SOURCES) {
    for (const row of rows) {
      const card = toModelCard(row)
      if (card !== undefined) cards.push(card)
    }
  }
  return cards
}

let memoized: ModelCatalog | undefined

export function generatedCatalogue(): ModelCatalog {
  memoized ??= catalogOf(generatedCards())
  return memoized
}

let indexed: ReadonlyMap<string, readonly ModelCard[]> | undefined

function cardsByProvider(): ReadonlyMap<string, readonly ModelCard[]> {
  if (indexed !== undefined) return indexed

  const index = new Map<string, ModelCard[]>()
  for (const card of generatedCards()) {
    const held = index.get(card.ref.providerId)
    if (held === undefined) index.set(card.ref.providerId, [card])
    else held.push(card)
  }

  indexed = index
  return indexed
}

export const cardsForProvider = (providerId: string): readonly ModelCard[] =>
  cardsByProvider().get(providerId) ?? []

export function withoutDatedDuplicates(cards: readonly ModelCard[]): readonly ModelCard[] {
  const aliased = new Set(
    cards.filter((card) => !RELEASE_STAMP.test(card.ref.modelId)).map((card) => refKey(card.ref)),
  )

  return cards.filter((card) => {
    const modelId = card.ref.modelId.replace(RELEASE_STAMP, '')
    if (modelId === card.ref.modelId) return true

    return !aliased.has(refKey({ providerId: card.ref.providerId, modelId }))
  })
}
