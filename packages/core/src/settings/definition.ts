import { ESettingKind, type SettingOption } from './value'

export enum ESettingPage {
  General = 'general',
  Appearance = 'appearance',
  Hidden = 'hidden',
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

export type TextDefinition = SettingFacts & {
  kind: ESettingKind.Text
  fallback: string
}

/** A model reference chosen through the switcher rather than typed, so the page hands off to it. */
export type ModelDefinition = SettingFacts & {
  kind: ESettingKind.Model
  fallback: string
}

export type SecretDefinition = SettingFacts & {
  kind: ESettingKind.Secret
  fallback: ''
  masked: boolean
  environmentVariable?: never
}

export type SettingDefinition =
  | ToggleDefinition
  | ChoiceDefinition
  | RangeDefinition
  | TextDefinition
  | ModelDefinition
  | SecretDefinition

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
