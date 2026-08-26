export enum ESettingKind {
  Toggle = 'toggle',
  Choice = 'choice',
  Range = 'range',
}

export type SettingValue = boolean | string | number

export type SettingOption = {
  value: string
  label: string
  detail?: string
}
