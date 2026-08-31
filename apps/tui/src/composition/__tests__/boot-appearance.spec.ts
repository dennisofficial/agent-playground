import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ESettingId } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { accentHex } from '../../ui/accents'
import { appearanceOf, applyAppearance } from '../../ui/appearance'
import { resetPalette } from '../../ui/palette-store'
import { theme } from '../../ui/theme'
import { loadSettings } from '../settings-binding'

const BOOT = join(import.meta.dir, '..', 'boot.tsx')

const workspaceWith = (accent: string): string => {
  const cwd = mkdtempSync(join(tmpdir(), 'atlas-appearance-'))
  mkdirSync(join(cwd, '.atlas'), { recursive: true })
  writeFileSync(
    join(cwd, '.atlas', 'settings.json'),
    JSON.stringify({ [ESettingId.Accent]: accent }),
    'utf8',
  )
  return cwd
}

describe('loadSettings', () => {
  it('resolves the operator accent without awaiting anything', () => {
    const settings = loadSettings({ env: {}, cwd: workspaceWith('moss') })

    try {
      applyAppearance(appearanceOf({ resolution: settings.service.snapshot().resolution }))
      expect(theme.accent).toBe(accentHex('moss'))
    } finally {
      resetPalette()
    }
  })
})

describe('bootAtlas', () => {
  it('puts the palette in force before the renderer can paint a frame in the shipped one', async () => {
    const source = await Bun.file(BOOT).text()

    const applied = source.indexOf('applyAppearance(')
    const renderer = source.indexOf('createCliRenderer({')

    expect(applied).toBeGreaterThan(-1)
    expect(renderer).toBeGreaterThan(applied)
  })
})
