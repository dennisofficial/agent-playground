import { describe, expect, it } from 'bun:test'

import { ESettingPage } from '../definition'
import { ESettingsLayer } from '../layers'
import { ATLAS_SETTINGS, ESettingId } from '../registry'
import { resolveSettings } from '../resolve'
import { ESettingKind } from '../value'

const quickModel = () => ATLAS_SETTINGS.find((definition) => definition.id === ESettingId.QuickModel)

describe('QuickModel setting', () => {
  it('is a model-kind row beside the default model, unset by default', () => {
    const definition = quickModel()

    expect(definition?.kind).toBe(ESettingKind.Model)
    expect(definition?.page).toBe(ESettingPage.General)
    expect(definition?.group).toBe('Model')
    expect(definition?.fallback).toBe('')
    expect(definition?.environmentVariable).toBe('ATLAS_QUICK_MODEL')
  })

  it('resolves to the empty fallback when nothing sets it', () => {
    const resolution = resolveSettings({ definitions: ATLAS_SETTINGS, layers: [] })

    expect(resolution.settings.get(ESettingId.QuickModel)?.value).toBe('')
  })

  it('takes a provider/model reference from a layer', () => {
    const resolution = resolveSettings({
      definitions: ATLAS_SETTINGS,
      layers: [
        {
          layer: ESettingsLayer.Environment,
          origin: 'environment',
          values: { [ESettingId.QuickModel]: 'openai/gpt-5.1-codex-mini' },
          origins: { [ESettingId.QuickModel]: 'ATLAS_QUICK_MODEL' },
        },
      ],
    })

    const held = resolution.settings.get(ESettingId.QuickModel)
    expect(held?.value).toBe('openai/gpt-5.1-codex-mini')
    expect(held?.origin).toBe('ATLAS_QUICK_MODEL')
    expect(resolution.rejected).toHaveLength(0)
  })

  it('rejects a value that is not a provider/model reference', () => {
    const resolution = resolveSettings({
      definitions: ATLAS_SETTINGS,
      layers: [
        {
          layer: ESettingsLayer.User,
          origin: '~/.atlas/settings.json',
          values: { [ESettingId.QuickModel]: 'haiku' },
        },
      ],
    })

    expect(resolution.rejected[0]?.id).toBe(ESettingId.QuickModel)
    expect(resolution.settings.get(ESettingId.QuickModel)?.value).toBe('')
  })
})
