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
import {
  defaultSelection,
  launchSelection,
  modelPinned,
  rememberDefault,
  storedModel,
  threadSelection,
} from '../model-preference'
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

describe('the default model pair', () => {
  it('answers with what Atlas ships when nothing was ever picked', () => {
    const selection = launched({})
    expect(refKey(selection.ref)).toBe(refKey(DEFAULT_MODEL_REF))
    expect(selection.effort).toBe(EEffort.Medium)
  })

  it('opens on the qualified pair the settings hold', () => {
    const selection = launched({
      values: {
        [ESettingId.ModelId]: 'anthropic/claude-opus-5',
        [ESettingId.ModelEffort]: EEffort.High,
      },
    })
    expect(refKey(selection.ref)).toBe('anthropic/claude-opus-5')
    expect(selection.effort).toBe(EEffort.High)
  })

  it('lets --model outrank the default pair, leaving the effort where it was', () => {
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

  it('ignores a default model no provider has an account for', () => {
    const selection = launched({ values: { [ESettingId.ModelId]: 'openai/gpt-5-codex' } })
    expect(refKey(selection.ref)).toBe(refKey(DEFAULT_MODEL_REF))
  })

  it('ignores a bare unqualified id, because a model is only ever a pair', () => {
    expect(refKey(launched({ values: { [ESettingId.ModelId]: 'claude-opus-5' } }).ref)).toBe(
      refKey(DEFAULT_MODEL_REF),
    )
  })

  it('ignores a default model that left the catalogue, and a junk effort', () => {
    const selection = launched({
      values: {
        [ESettingId.ModelId]: 'anthropic/claude-opus-3',
        [ESettingId.ModelEffort]: 'colossal',
      },
    })
    expect(refKey(selection.ref)).toBe(refKey(DEFAULT_MODEL_REF))
    expect(selection.effort).toBe(EEffort.Medium)
  })

  it('drops a default rung the chosen model does not offer onto one it does', () => {
    const selection = launched({
      values: {
        [ESettingId.ModelId]: 'anthropic/claude-haiku-4-5',
        [ESettingId.ModelEffort]: EEffort.Max,
      },
    })
    expect(selection.effort).toBe(EEffort.High)
  })
})

describe('the pair a conversation carries', () => {
  const fallback = defaultSelection({ settled: settled({}), catalogue })

  it('falls back to the default when the conversation has never been switched', () => {
    const selection = threadSelection({ stored: undefined, fallback, catalogue })
    expect(refKey(selection.ref)).toBe(refKey(DEFAULT_MODEL_REF))
    expect(selection.effort).toBe(fallback.effort)
  })

  it('outranks the default, which is what stops two terminals fighting over one pair', () => {
    const selection = threadSelection({
      stored: { ref: 'anthropic/claude-opus-5', effort: EEffort.High },
      fallback,
      catalogue,
    })
    expect(refKey(selection.ref)).toBe('anthropic/claude-opus-5')
    expect(selection.effort).toBe(EEffort.High)
  })

  it('falls back whole when the model went away, so the effort never outlives it', () => {
    const settledHigh = defaultSelection({
      settled: settled({
        values: {
          [ESettingId.ModelId]: 'anthropic/claude-sonnet-5',
          [ESettingId.ModelEffort]: EEffort.Low,
        },
      }),
      catalogue,
    })
    const selection = threadSelection({
      stored: { ref: 'anthropic/claude-opus-3', effort: EEffort.Max },
      fallback: settledHigh,
      catalogue,
    })

    expect(refKey(selection.ref)).toBe('anthropic/claude-sonnet-5')
    expect(selection.effort).toBe(EEffort.Low)
  })

  it('keeps the model and drops a junk effort back onto the default', () => {
    const selection = threadSelection({
      stored: { ref: 'anthropic/claude-opus-5', effort: 'colossal' },
      fallback,
      catalogue,
    })
    expect(refKey(selection.ref)).toBe('anthropic/claude-opus-5')
    expect(selection.effort).toBe(fallback.effort)
  })

  it('drops a rung the stored model does not offer onto one it does', () => {
    const selection = threadSelection({
      stored: { ref: 'anthropic/claude-haiku-4-5', effort: EEffort.Max },
      fallback,
      catalogue,
    })
    expect(selection.effort).toBe(EEffort.High)
  })

  it('writes back the qualified pair the store reads', () => {
    expect(
      storedModel({ ref: { providerId: 'anthropic', modelId: 'claude-opus-5' }, effort: EEffort.High }),
    ).toEqual({ ref: 'anthropic/claude-opus-5', effort: EEffort.High })
  })
})

describe('a launch pinned to one model', () => {
  it('is pinned only when the flag names a model something can answer for', () => {
    expect(modelPinned({ requested: { model: 'anthropic/claude-opus-5' }, catalogue })).toBe(true)
    expect(modelPinned({ requested: { model: undefined }, catalogue })).toBe(false)
    expect(modelPinned({ requested: { model: 'openai/gpt-5-codex' }, catalogue })).toBe(false)
    expect(modelPinned({ requested: { model: 'claude-opus-5' }, catalogue })).toBe(false)
  })
})

describe('writing the default pair down', () => {
  it('survives the settings service being rebuilt over the same store', () => {
    const store = new MemorySettingsStore()
    rememberDefault({
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

    rememberDefault({
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
