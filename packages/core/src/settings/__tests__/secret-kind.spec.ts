import { describe, expect, it } from 'bun:test'

import { coerceSettingValue } from '../coerce'
import { activateSetting, adjustSetting } from '../edit'
import { ESettingsLayer } from '../layers'
import { resolveSettings } from '../resolve'
import { secret, toggle } from './fixture'

describe('a secret setting', () => {
  it('refuses every value a settings file could hold', () => {
    for (const raw of ['tvly-abcd', '', 42, true, null, { value: 'tvly-abcd' }]) {
      const coerced = coerceSettingValue({ definition: secret, raw })
      expect(coerced.ok).toBe(false)
    }
  })

  it('says why, so a key pasted into the file is not silently ignored', () => {
    const coerced = coerceSettingValue({ definition: secret, raw: 'tvly-abcd' })
    expect(coerced.ok ? '' : coerced.reason).toBe('a secret is not read from a settings file')
  })

  it('resolves to nothing however many layers try to set it', () => {
    const resolution = resolveSettings({
      definitions: [secret, toggle],
      layers: [
        {
          layer: ESettingsLayer.User,
          origin: 'settings.json',
          values: { 'demo.secret': 'tvly-from-user' },
        },
        {
          layer: ESettingsLayer.Environment,
          origin: 'the environment',
          values: { 'demo.secret': 'tvly-from-env' },
        },
      ],
    })

    expect(resolution.settings.get('demo.secret')?.value).toBe('')
    expect(resolution.settings.get('demo.secret')?.layer).toBe(ESettingsLayer.Default)
    expect(resolution.rejected.map((held) => [held.id, held.layer])).toEqual([
      ['demo.secret', ESettingsLayer.User],
      ['demo.secret', ESettingsLayer.Environment],
    ])
  })

  it('is unmoved by the keys that edit every other kind', () => {
    expect(activateSetting({ definition: secret, current: '' })).toBe('')
    expect(adjustSetting({ definition: secret, current: '', delta: 1 })).toBe('')
    expect(adjustSetting({ definition: secret, current: '', delta: -1 })).toBe('')
  })
})
