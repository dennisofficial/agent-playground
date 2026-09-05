import { findCard, type ModelCatalog } from './card'
import { parseRef, type ModelRef } from './ref'

export enum EUtilityModelRole {
  Tldr = 'tldr',
  Titler = 'titler',
  Judge = 'judge',
}

const SHIPPED_QUICK_MODEL: ModelRef = {
  providerId: 'anthropic',
  modelId: 'claude-haiku-4-5-20251001',
}

export const UTILITY_MODEL_DEFAULTS: Readonly<Record<EUtilityModelRole, ModelRef>> = {
  [EUtilityModelRole.Tldr]: SHIPPED_QUICK_MODEL,
  [EUtilityModelRole.Titler]: SHIPPED_QUICK_MODEL,
  [EUtilityModelRole.Judge]: SHIPPED_QUICK_MODEL,
}

export function resolveUtilityModel(args: {
  role: EUtilityModelRole
  override: string
  catalogue: ModelCatalog
}): ModelRef {
  const fallback = UTILITY_MODEL_DEFAULTS[args.role]

  const parsed = parseRef(args.override)
  if (parsed === undefined) return fallback

  if (findCard({ catalog: args.catalogue, ref: parsed }) === undefined) return fallback

  return parsed
}
