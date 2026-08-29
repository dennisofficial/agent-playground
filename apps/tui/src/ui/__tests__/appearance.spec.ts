import {
  ATLAS_SETTINGS,
  ESettingId,
  ESettingsLayer,
  resolveSettings,
  type SettingValue,
} from '@dltech/atlas-core'
import { afterEach, describe, expect, it } from 'bun:test'

import { accentHex } from '../accents'
import { appearanceOf, applyAppearance, SHIPPED_ACCENT } from '../appearance'
import { applyBlockDensity, blockDensity, EBlockDensity, SHIPPED_DENSITY } from '../density-store'
import { paletteVersion, resetPalette, subscribePalette } from '../palette-store'
import { theme } from '../theme'

afterEach(() => {
  resetPalette()
  applyBlockDensity(SHIPPED_DENSITY)
})

const resolutionOf = (values: Record<string, SettingValue>) =>
  resolveSettings({
    definitions: ATLAS_SETTINGS,
    layers: [{ layer: ESettingsLayer.User, origin: 'a settings file', values }],
  })

describe('appearanceOf', () => {
  it('reads the shipped look when nothing has been chosen', () => {
    expect(appearanceOf({ resolution: resolutionOf({}) })).toEqual({
      accent: SHIPPED_ACCENT,
      density: SHIPPED_DENSITY,
    })
  })

  it('reads what the settings actually hold', () => {
    const resolution = resolutionOf({
      [ESettingId.Accent]: 'moss',
      [ESettingId.BlockPadding]: 'compact',
    })

    expect(appearanceOf({ resolution })).toEqual({
      accent: 'moss',
      density: EBlockDensity.Compact,
    })
  })
})

describe('applyAppearance', () => {
  it('moves the whole palette onto the chosen accent', () => {
    applyAppearance({ accent: 'moss', density: SHIPPED_DENSITY })

    expect(theme.accent).toBe(accentHex('moss'))
    expect(theme.codeInline).toBe(accentHex('moss'))
    expect(theme.court.agent).toBe(accentHex('moss'))
  })

  it('moves the density', () => {
    applyAppearance({ accent: SHIPPED_ACCENT, density: EBlockDensity.Compact })
    expect(blockDensity()).toBe(EBlockDensity.Compact)
  })

  it('repaints nothing when the look is already the one asked for', () => {
    applyAppearance({ accent: 'moss', density: EBlockDensity.Compact })

    const before = paletteVersion()
    let repaints = 0
    const unsubscribe = subscribePalette(() => {
      repaints += 1
    })

    applyAppearance({ accent: 'moss', density: EBlockDensity.Compact })
    unsubscribe()

    expect(paletteVersion()).toBe(before)
    expect(repaints).toBe(0)
  })
})
