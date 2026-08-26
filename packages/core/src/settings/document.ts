import type { JsonValue } from '../json'
import type { SettingValue } from './value'

export type SettingsDocument = {
  values: Readonly<Record<string, JsonValue>>
}

export type SettingsRead = {
  document: SettingsDocument
  problem?: string
}

export const EMPTY_SETTINGS_DOCUMENT: SettingsDocument = { values: {} }

const RESERVED_PREFIX = '$'

const isRecord = (raw: JsonValue): raw is { [key: string]: JsonValue } =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)

export function parseSettingsDocument(raw: JsonValue): SettingsDocument {
  if (!isRecord(raw)) return EMPTY_SETTINGS_DOCUMENT

  const values: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith(RESERVED_PREFIX)) continue
    values[key] = value
  }

  return { values }
}

export function withSetting(args: {
  document: SettingsDocument
  id: string
  value: SettingValue
}): SettingsDocument {
  return { values: { ...args.document.values, [args.id]: args.value } }
}

export function withoutSetting(args: {
  document: SettingsDocument
  id: string
}): SettingsDocument {
  const values = { ...args.document.values }
  delete values[args.id]
  return { values }
}

export function serialiseSettingsDocument(document: SettingsDocument): string {
  const ordered: Record<string, JsonValue> = {}
  for (const key of Object.keys(document.values).sort()) {
    const value = document.values[key]
    if (value !== undefined) ordered[key] = value
  }

  return `${JSON.stringify(ordered, null, 2)}\n`
}
