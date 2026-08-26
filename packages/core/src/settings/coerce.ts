import { ESettingKind, type SettingValue } from './value'
import { optionOf, type SettingDefinition } from './definition'

export type SettingCoercion = { ok: true; value: SettingValue } | { ok: false; reason: string }

const AFFIRMATIVE: readonly string[] = ['1', 'true', 'on', 'yes']

const NEGATIVE: readonly string[] = ['0', 'false', 'off', 'no']

const asBoolean = (raw: unknown): boolean | undefined => {
  if (typeof raw === 'boolean') return raw
  if (typeof raw !== 'string') return undefined

  const word = raw.trim().toLowerCase()
  if (AFFIRMATIVE.includes(word)) return true
  if (NEGATIVE.includes(word)) return false
  return undefined
}

const asNumber = (raw: unknown): number | undefined => {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string') return undefined

  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

export function coerceSettingValue(args: {
  definition: SettingDefinition
  raw: unknown
}): SettingCoercion {
  const { definition, raw } = args

  if (definition.kind === ESettingKind.Toggle) {
    const value = asBoolean(raw)
    return value === undefined ? { ok: false, reason: 'expected on or off' } : { ok: true, value }
  }

  if (definition.kind === ESettingKind.Choice) {
    if (typeof raw !== 'string' || optionOf({ definition, value: raw }) === undefined) {
      const allowed = definition.options.map((option) => option.value).join(', ')
      return { ok: false, reason: `expected one of ${allowed}` }
    }
    return { ok: true, value: raw }
  }

  const value = asNumber(raw)
  if (value === undefined || value < definition.minimum || value > definition.maximum) {
    return {
      ok: false,
      reason: `expected a number from ${definition.minimum} to ${definition.maximum}`,
    }
  }
  return { ok: true, value }
}
