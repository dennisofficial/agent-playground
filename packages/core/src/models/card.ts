import type { EImageTier } from '../images/projection'
import type { EffortMap } from './effort-ladder'
import { refKey, type ModelRef } from './ref'

export type ModelCost = {
  inputPerMillion: number
  outputPerMillion: number
}

export type ModelCard = {
  ref: ModelRef
  label: string
  api: string
  contextWindow: number
  imageTier: EImageTier
  maxOutputTokens?: number
  cost?: ModelCost
  effort?: EffortMap
}

export type ModelCatalog = ReadonlyMap<string, ModelCard>

export const catalogOf = (cards: readonly ModelCard[]): ModelCatalog =>
  new Map(cards.map((card) => [refKey(card.ref), card]))

export const findCard = (args: { catalog: ModelCatalog; ref: ModelRef }): ModelCard | undefined =>
  args.catalog.get(refKey(args.ref))
