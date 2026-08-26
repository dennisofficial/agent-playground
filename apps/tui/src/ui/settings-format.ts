import {
  ESettingKind,
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

export const OPTION_SEPARATOR = ' · '

export function valueLabel(args: {
  definition: SettingDefinition
  value: SettingValue
}): string {
  const { definition, value } = args

  if (definition.kind === ESettingKind.Toggle) return value === true ? ON : OFF
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

  return definition.options.map((option) => option.label).join(OPTION_SEPARATOR)
}

export function provenanceOf(setting: ResolvedSetting): string {
  return `${setting.layer} · ${setting.origin}`
}
