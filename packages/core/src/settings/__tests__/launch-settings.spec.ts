import { describe, expect, it } from 'bun:test'

import { coerceSettingValue } from '../coerce'
import { definitionsOfPage, ESettingPage, type TextDefinition } from '../definition'
import { ESettingsLayer } from '../layers'
import { ATLAS_SETTINGS, ESettingId, SETTING_PAGES } from '../registry'
import { resolveSettings, textValueOf } from '../resolve'
import { ESettingKind } from '../value'

const LAUNCH_SETTINGS: readonly ESettingId[] = [
  ESettingId.ModelId,
  ESettingId.ModelEffort,
  ESettingId.SubagentModel,
  ESettingId.DatabaseUrl,
  ESettingId.KeychainService,
]

const definitionOf = (id: ESettingId) => {
  const found = ATLAS_SETTINGS.find((definition) => definition.id === id)
  if (found === undefined) throw new Error(`${id} is not a registered setting`)
  return found
}

const textDefinition = (id: ESettingId): TextDefinition => {
  const definition = definitionOf(id)
  if (definition.kind !== ESettingKind.Text) throw new Error(`${id} is not text`)
  return definition
}

const resolutionOver = (args: {
  file?: Record<string, unknown>
  env?: Record<string, unknown>
}) =>
  resolveSettings({
    definitions: ATLAS_SETTINGS,
    layers: [
      { layer: ESettingsLayer.User, origin: 'settings.json', values: args.file ?? {} },
      { layer: ESettingsLayer.Environment, origin: 'environment', values: args.env ?? {} },
    ],
  })

describe('the settings a launch used to carry in its environment', () => {
  it('registers every one of them, so the layers own them rather than argv', () => {
    for (const id of LAUNCH_SETTINGS) expect(definitionOf(id).id).toBe(id)
  })

  it('declares the environment variable each one answered to before', () => {
    expect(LAUNCH_SETTINGS.map((id) => definitionOf(id).environmentVariable)).toEqual([
      'ATLAS_MODEL',
      'ATLAS_EFFORT',
      'ATLAS_SUBAGENT_MODEL',
      'ATLAS_DATABASE_URL',
      'ATLAS_KEYCHAIN_SERVICE',
    ])
  })

  it('keeps them off every page the overlay walks, because none is a knob to twiddle', () => {
    const shown = SETTING_PAGES.flatMap((page) =>
      definitionsOfPage({ definitions: ATLAS_SETTINGS, page: page.id }).map(
        (definition) => definition.id,
      ),
    )

    for (const id of LAUNCH_SETTINGS) expect(shown).not.toContain(id)
    expect(SETTING_PAGES.map((page) => page.id)).not.toContain(ESettingPage.Hidden)
  })

  it('reads empty as unset, which is what makes a fallback the caller owns possible', () => {
    for (const id of LAUNCH_SETTINGS.filter((held) => held !== ESettingId.ModelEffort)) {
      expect(textDefinition(id).fallback).toBe('')
    }

    expect(textValueOf({ resolution: resolutionOver({}), id: ESettingId.DatabaseUrl })).toBe('')
  })

  it('lets the environment outrank the file, which is the whole point of the move', () => {
    const resolution = resolutionOver({
      file: { [ESettingId.DatabaseUrl]: 'file:/tmp/from-file.db' },
      env: { [ESettingId.DatabaseUrl]: 'file:/tmp/from-env.db' },
    })

    expect(textValueOf({ resolution, id: ESettingId.DatabaseUrl })).toBe('file:/tmp/from-env.db')
    expect(resolution.settings.get(ESettingId.DatabaseUrl)?.layer).toBe(ESettingsLayer.Environment)
  })

  it('reports where a value came from, which an env read of its own never could', () => {
    const resolution = resolutionOver({ file: { [ESettingId.ModelId]: 'claude-opus-5' } })

    expect(resolution.settings.get(ESettingId.ModelId)?.origin).toBe('settings.json')
  })
})

describe('a text setting', () => {
  it('takes any string, since a path and a model id have no shape to check', () => {
    const definition = textDefinition(ESettingId.DatabaseUrl)

    expect(coerceSettingValue({ definition, raw: 'file:/tmp/x.db' })).toEqual({
      ok: true,
      value: 'file:/tmp/x.db',
    })
    expect(coerceSettingValue({ definition, raw: '' })).toEqual({ ok: true, value: '' })
  })

  it('refuses what is not text at all, rather than stringifying it', () => {
    const definition = textDefinition(ESettingId.DatabaseUrl)

    expect(coerceSettingValue({ definition, raw: 42 }).ok).toBe(false)
    expect(coerceSettingValue({ definition, raw: null }).ok).toBe(false)
  })
})
