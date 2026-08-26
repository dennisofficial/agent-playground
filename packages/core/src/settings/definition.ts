import { ESettingKind, type SettingOption } from './value'

export enum ESettingPage {
  General = 'general',
  Appearance = 'appearance',
}

export type SettingPage = {
  id: ESettingPage
  label: string
}

type SettingFacts = {
  id: string
  page: ESettingPage
  group: string
  label: string
  description: string
  environmentVariable?: string
}

export type ToggleDefinition = SettingFacts & {
  kind: ESettingKind.Toggle
  fallback: boolean
}

export type ChoiceDefinition = SettingFacts & {
  kind: ESettingKind.Choice
  fallback: string
  options: readonly SettingOption[]
}

export type RangeDefinition = SettingFacts & {
  kind: ESettingKind.Range
  fallback: number
  minimum: number
  maximum: number
  step: number
  unit: string
}

export type SettingDefinition = ToggleDefinition | ChoiceDefinition | RangeDefinition

export function definitionsOfPage(args: {
  definitions: readonly SettingDefinition[]
  page: ESettingPage
}): readonly SettingDefinition[] {
  return args.definitions.filter((definition) => definition.page === args.page)
}

export function optionOf(args: {
  definition: ChoiceDefinition
  value: string
}): SettingOption | undefined {
  return args.definition.options.find((option) => option.value === args.value)
}
