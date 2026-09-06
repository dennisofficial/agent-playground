import { EEffort } from '@dltech/atlas-core'

export const EFFORT_ABBREVIATION: Readonly<Record<EEffort, string>> = {
  [EEffort.Off]: 'off',
  [EEffort.Minimal]: 'min',
  [EEffort.Low]: 'low',
  [EEffort.Medium]: 'med',
  [EEffort.High]: 'high',
  [EEffort.XHigh]: 'xhi',
  [EEffort.Max]: 'max',
}

export const EFFORT_WORD: Readonly<Record<EEffort, string>> = {
  [EEffort.Off]: 'off',
  [EEffort.Minimal]: 'minimal',
  [EEffort.Low]: 'low',
  [EEffort.Medium]: 'medium',
  [EEffort.High]: 'high',
  [EEffort.XHigh]: 'xhigh',
  [EEffort.Max]: 'max',
}
