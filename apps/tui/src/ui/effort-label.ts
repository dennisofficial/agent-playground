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
