export enum ESettingKind {
  Toggle = 'toggle',
  Choice = 'choice',
  Range = 'range',
  Text = 'text',
  Secret = 'secret',
}

export type SettingValue = boolean | string | number

export type SettingOption = {
  value: string
  label: string
  detail?: string
  /** What choosing this one costs and buys, for the pane beside the list. */
  note?: string
}
