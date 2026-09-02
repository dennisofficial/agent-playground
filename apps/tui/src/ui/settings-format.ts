import {
  ESettingKind,
  maskStoredSecret,
  optionOf,
  type ResolvedSetting,
  type SettingDefinition,
  type SettingValue,
} from '@dltech/atlas-core'

import { theme } from './theme'

export const ON = 'on'

export const OFF = 'off'

export const TOGGLE_HINT = '⏎ toggle'

export const RANGE_HINT = '← → adjust'

export const TEXT_HINT = 'set in the settings file'

export const MODEL_HINT = '⏎ choose'

export const MODEL_NOT_SET = 'shipped default'

export const SECRET_HINT = '⏎ set'

export const SECRET_NOT_NEEDED = 'not needed'

export const SECRET_NOT_SET = 'not set'

export const OPTION_SEPARATOR = ' · '

export function valueLabel(args: {
  definition: SettingDefinition
  value: SettingValue
}): string {
  const { definition, value } = args

  if (definition.kind === ESettingKind.Toggle) return value === true ? ON : OFF
  if (definition.kind === ESettingKind.Secret) return SECRET_NOT_SET
  if (definition.kind === ESettingKind.Text) {
    return typeof value === 'string' ? value : definition.fallback
  }
  if (definition.kind === ESettingKind.Model) {
    return typeof value === 'string' && value.length > 0 ? value : MODEL_NOT_SET
  }
  if (definition.kind === ESettingKind.Choice) {
    if (typeof value !== 'string') return definition.fallback
    return optionOf({ definition, value })?.label ?? value
  }

  return `${typeof value === 'number' ? value : definition.fallback}${definition.unit}`
}

export function valueColour(args: { definition: SettingDefinition; value: SettingValue }): string {
  if (args.definition.kind !== ESettingKind.Toggle) return theme.meta
  return args.value === true ? theme.ok : theme.warn
}

export function affordanceHint(definition: SettingDefinition): string {
  if (definition.kind === ESettingKind.Toggle) return TOGGLE_HINT
  if (definition.kind === ESettingKind.Range) return RANGE_HINT
  if (definition.kind === ESettingKind.Text) return TEXT_HINT
  if (definition.kind === ESettingKind.Model) return MODEL_HINT
  if (definition.kind === ESettingKind.Secret) return SECRET_HINT

  return definition.options.map((option) => option.label).join(OPTION_SEPARATOR)
}

export function secretDisplay(args: {
  held: string | undefined
  masked: boolean
  required: boolean
  takesOne: boolean
}): { text: string; fg: string } {
  if (!args.takesOne) return { text: SECRET_NOT_NEEDED, fg: theme.meta }

  if (args.held === undefined || args.held.length === 0) {
    return { text: SECRET_NOT_SET, fg: args.required ? theme.warn : theme.meta }
  }

  return { text: args.masked ? maskStoredSecret(args.held) : args.held, fg: theme.ok }
}

export function provenanceOf(setting: ResolvedSetting): string {
  return `${setting.layer} · ${setting.origin}`
}
