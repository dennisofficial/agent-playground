import { EMeterBand } from '@dltech/atlas-core'

import { theme } from './theme'

const HOT = '#e08a45'

export function meterTone(band: EMeterBand): string {
  if (band === EMeterBand.Unknown) return theme.rule
  if (band === EMeterBand.Warn) return theme.warn
  if (band === EMeterBand.Hot) return HOT
  if (band === EMeterBand.Red || band === EMeterBand.Spent) return theme.error
  return theme.meta
}
