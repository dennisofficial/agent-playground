import { choiceValueOf, ESettingId, rangeValueOf, type SettingsResolution } from '@dltech/atlas-core'

import { accentHex, accentPalette } from './accents'
import {
  applyComposerEdge,
  composerEdgeOf,
  SHIPPED_COMPOSER_EDGE,
  type EComposerEdge,
} from './composer-edge-store'
import { applyBlockDensity, blockDensityOf, SHIPPED_DENSITY, type EBlockDensity } from './density-store'
import { applyImageRows, SHIPPED_IMAGE_ROWS } from './image-rows-store'
import { applyPalette } from './palette-store'
import { theme } from './theme'

export const SHIPPED_ACCENT = 'clay'

export type Appearance = {
  accent: string
  density: EBlockDensity
  composer: EComposerEdge
  imageRows: number
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
    composer: composerEdgeOf(
      choiceValueOf({
        resolution: args.resolution,
        id: ESettingId.ComposerEdge,
        fallback: SHIPPED_COMPOSER_EDGE,
      }),
    ),
    imageRows: rangeValueOf({
      resolution: args.resolution,
      id: ESettingId.ImageRows,
      fallback: SHIPPED_IMAGE_ROWS,
    }),
  }
}

export function applyAppearance(appearance: Appearance): void {
  if (theme.accent !== accentHex(appearance.accent)) applyPalette(accentPalette(appearance.accent))
  applyBlockDensity(appearance.density)
  applyComposerEdge(appearance.composer)
  applyImageRows(appearance.imageRows)
}
