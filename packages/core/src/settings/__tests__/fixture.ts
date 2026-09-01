import { ESettingPage, type SettingDefinition } from '../definition'
import { ESettingKind } from '../value'

export const toggle: SettingDefinition = {
  id: 'demo.toggle',
  page: ESettingPage.General,
  group: 'Demo',
  label: 'Demo toggle',
  description: 'A toggle.',
  environmentVariable: 'DEMO_TOGGLE',
  kind: ESettingKind.Toggle,
  fallback: true,
}

export const choice: SettingDefinition = {
  id: 'demo.choice',
  page: ESettingPage.General,
  group: 'Demo',
  label: 'Demo choice',
  description: 'A choice.',
  kind: ESettingKind.Choice,
  fallback: 'ask',
  options: [
    { value: 'ask', label: 'ask' },
    { value: 'never', label: 'never' },
    { value: 'always', label: 'always' },
  ],
}

export const range: SettingDefinition = {
  id: 'demo.range',
  page: ESettingPage.Appearance,
  group: 'Demo',
  label: 'Demo range',
  description: 'A range.',
  kind: ESettingKind.Range,
  fallback: 40,
  minimum: 30,
  maximum: 50,
  step: 5,
  unit: ' cols',
}

export const DEMO_SETTINGS: readonly SettingDefinition[] = [toggle, choice, range]

export const secret: SettingDefinition = {
  id: 'demo.secret',
  page: ESettingPage.General,
  group: 'Demo',
  label: 'Demo key',
  description: 'A key.',
  kind: ESettingKind.Secret,
  fallback: '',
  masked: true,
}
