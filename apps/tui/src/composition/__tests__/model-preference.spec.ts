import { describe, expect, it } from 'bun:test'

import {
  ATLAS_SETTINGS,
  EEffort,
  ESettingId,
  refKey,
  type SettingsResolution,
} from '@dltech/atlas-core'
import { createSettingsService, environmentLayer, MemorySettingsStore } from '@dltech/atlas-harness'

import { DEFAULT_MODEL_REF } from '../config'
import { launchSelection, rememberSelection } from '../model-preference'
import { fakeCatalogue } from './fake-app'

const NOTHING = { model: undefined }

const catalogue = fakeCatalogue()

const serviceOver = (store: MemorySettingsStore) =>
  createSettingsService({ definitions: ATLAS_SETTINGS, user: store })

const settled = (args: {
  values?: Record<string, string>
  env?: Record<string, string | undefined>
}): SettingsResolution =>
  createSettingsService({
    definitions: ATLAS_SETTINGS,
    user: new MemorySettingsStore({ document: { values: args.values ?? {} } }),
    ...(args.env === undefined
      ? {}
      : { environment: environmentLayer({ definitions: ATLAS_SETTINGS, env: args.env }) }),
  }).snapshot().resolution

const launched = (args: {
  requested?: { model: string | undefined }
  values?: Record<string, string>
  env?: Record<string, string | undefined>
}) =>
  launchSelection({
    requested: args.requested ?? NOTHING,
    settled: settled({
      ...(args.values === undefined ? {} : { values: args.values }),
      ...(args.env === undefined ? {} : { env: args.env }),
    }),
    catalogue,
  })

describe('the remembered model pair', () => {
  it('answers with what Atlas ships when nothing was ever picked', () => {
    const selection = launched({})
    expect(refKey(selection.ref)).toBe(refKey(DEFAULT_MODEL_REF))
    expect(selection.effort).toBe(EEffort.Medium)
  })

  it('reopens on the qualified pair the switcher last wrote', () => {
    const selection = launched({
      values: {
        [ESettingId.ModelId]: 'anthropic/claude-opus-5',
        [ESettingId.ModelEffort]: EEffort.High,
      },
    })
    expect(refKey(selection.ref)).toBe('anthropic/claude-opus-5')
    expect(selection.effort).toBe(EEffort.High)
  })

  it('lets --model outrank the remembered pair, leaving the effort where it was', () => {
    const selection = launched({
      requested: { model: 'anthropic/claude-sonnet-5' },
      values: {
        [ESettingId.ModelId]: 'anthropic/claude-opus-5',
        [ESettingId.ModelEffort]: EEffort.High,
      },
    })
    expect(refKey(selection.ref)).toBe('anthropic/claude-sonnet-5')
    expect(selection.effort).toBe(EEffort.High)
  })

  it('lets the environment outrank the file, and the command line outrank both', () => {
    const values = { [ESettingId.ModelId]: 'anthropic/claude-opus-5' }
    const env = { ATLAS_MODEL: 'anthropic/claude-haiku-4-5', ATLAS_EFFORT: EEffort.Low }

    expect(refKey(launched({ values, env }).ref)).toBe('anthropic/claude-haiku-4-5')
    expect(
      refKey(launched({ requested: { model: 'anthropic/claude-sonnet-5' }, values, env }).ref),
    ).toBe('anthropic/claude-sonnet-5')
  })

  it('ignores a remembered model no provider has an account for', () => {
    const selection = launched({ values: { [ESettingId.ModelId]: 'openai/gpt-5-codex' } })
    expect(refKey(selection.ref)).toBe(refKey(DEFAULT_MODEL_REF))
  })

  it('ignores a bare unqualified id, because a model is only ever a pair', () => {
    expect(refKey(launched({ values: { [ESettingId.ModelId]: 'claude-opus-5' } }).ref)).toBe(
      refKey(DEFAULT_MODEL_REF),
    )
  })

  it('ignores a remembered model that left the catalogue, and a junk effort', () => {
    const selection = launched({
      values: {
        [ESettingId.ModelId]: 'anthropic/claude-opus-3',
        [ESettingId.ModelEffort]: 'colossal',
      },
    })
    expect(refKey(selection.ref)).toBe(refKey(DEFAULT_MODEL_REF))
    expect(selection.effort).toBe(EEffort.Medium)
  })

  it('drops a remembered rung the chosen model does not offer onto one it does', () => {
    const selection = launched({
      values: {
        [ESettingId.ModelId]: 'anthropic/claude-haiku-4-5',
        [ESettingId.ModelEffort]: EEffort.Max,
      },
    })
    expect(selection.effort).toBe(EEffort.High)
  })
})

describe('writing the picked pair down', () => {
  it('survives the settings service being rebuilt over the same store', () => {
    const store = new MemorySettingsStore()
    rememberSelection({
      settings: serviceOver(store),
      selection: {
        ref: { providerId: 'anthropic', modelId: 'claude-opus-5' },
        effort: EEffort.High,
      },
    })

    const selection = launchSelection({
      requested: NOTHING,
      settled: serviceOver(store).snapshot().resolution,
      catalogue,
    })
    expect(refKey(selection.ref)).toBe('anthropic/claude-opus-5')
    expect(selection.effort).toBe(EEffort.High)
  })

  it('leaves every other setting in the file alone', () => {
    const store = new MemorySettingsStore({ document: { values: { 'appearance.accent': 'moss' } } })
    const settings = serviceOver(store)

    rememberSelection({
      settings,
      selection: {
        ref: { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
        effort: EEffort.Low,
      },
    })

    expect(store.document().values).toEqual({
      'appearance.accent': 'moss',
      [ESettingId.ModelId]: 'anthropic/claude-sonnet-5',
      [ESettingId.ModelEffort]: EEffort.Low,
    })
  })
})
