import { choiceValueOf, ESettingId, type SettingsResolution } from '@dltech/atlas-core'

import { accentHex, accentPalette } from './accents'
import { applyBlockDensity, blockDensityOf, SHIPPED_DENSITY, type EBlockDensity } from './density-store'
import { applyPalette } from './palette-store'
import { theme } from './theme'

export const SHIPPED_ACCENT = 'clay'

export type Appearance = {
  accent: string
  density: EBlockDensity
}

export function appearanceOf(args: { resolution: SettingsResolution }): Appearance {
  return {
    accent: choiceValueOf({
      resolution: args.resolution,
      id: ESettingId.Accent,
      fallback: SHIPPED_ACCENT,
    }),
    density: blockDensityOf(
      choiceValueOf({
        resolution: args.resolution,
        id: ESettingId.BlockPadding,
        fallback: SHIPPED_DENSITY,
      }),
    ),
  }
}

export function applyAppearance(appearance: Appearance): void {
  if (theme.accent !== accentHex(appearance.accent)) applyPalette(accentPalette(appearance.accent))
  applyBlockDensity(appearance.density)
}
