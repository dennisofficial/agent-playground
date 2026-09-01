import { ESettingId } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { previewFor } from '../components/settings/previews'

describe('the settings preview registry', () => {
  it('previews a setting that changes how the app looks', () => {
    expect(previewFor(ESettingId.Accent)).toBeDefined()
  })

  it('previews nothing for a setting whose effect is already on screen', () => {
    expect(previewFor(ESettingId.SidebarWidth)).toBeUndefined()
  })
})
