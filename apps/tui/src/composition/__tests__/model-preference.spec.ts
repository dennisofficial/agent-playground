import { describe, expect, it } from 'bun:test'

import { ATLAS_SETTINGS, EEffort, type SettingsDocument } from '@dltech/atlas-core'
import { createSettingsService, MemorySettingsStore } from '@dltech/atlas-harness'

import { DEFAULT_MODEL_ID } from '../config'
import {
  launchSelection,
  rememberSelection,
  REMEMBERED_EFFORT,
  REMEMBERED_MODEL_ID,
} from '../model-preference'

const NOTHING = { modelId: undefined, thinkingBudgetTokens: undefined }

const NOTHING_REMEMBERED: SettingsDocument = { values: {} }

const remembering = (values: Record<string, string>): SettingsDocument => ({ values })

const serviceOver = (store: MemorySettingsStore) =>
  createSettingsService({ definitions: ATLAS_SETTINGS, user: store })

describe('the remembered model pair', () => {
  it('answers with what Atlas ships when nothing was ever picked', () => {
    expect(launchSelection({ requested: NOTHING, remembered: NOTHING_REMEMBERED })).toEqual({
      modelId: DEFAULT_MODEL_ID,
      effort: EEffort.Medium,
    })
  })

  it('reopens on the pair the switcher last wrote', () => {
    expect(
      launchSelection({
        requested: NOTHING,
        remembered: remembering({
          [REMEMBERED_MODEL_ID]: 'claude-opus-5',
          [REMEMBERED_EFFORT]: EEffort.High,
        }),
      }),
    ).toEqual({ modelId: 'claude-opus-5', effort: EEffort.High })
  })

  it('lets a launch override outrank the remembered pair', () => {
    expect(
      launchSelection({
        requested: { modelId: 'claude-sonnet-5', thinkingBudgetTokens: 1024 },
        remembered: remembering({
          [REMEMBERED_MODEL_ID]: 'claude-opus-5',
          [REMEMBERED_EFFORT]: EEffort.High,
        }),
      }),
    ).toEqual({ modelId: 'claude-sonnet-5', effort: EEffort.Low })
  })

  it('ignores a remembered model no credential can answer for', () => {
    expect(
      launchSelection({
        requested: NOTHING,
        remembered: remembering({ [REMEMBERED_MODEL_ID]: 'gpt-5-codex' }),
      }).modelId,
    ).toBe(DEFAULT_MODEL_ID)
  })

  it('ignores a remembered model that left the catalog, and a junk effort', () => {
    expect(
      launchSelection({
        requested: NOTHING,
        remembered: remembering({
          [REMEMBERED_MODEL_ID]: 'claude-opus-3',
          [REMEMBERED_EFFORT]: 'colossal',
        }),
      }),
    ).toEqual({ modelId: DEFAULT_MODEL_ID, effort: EEffort.Medium })
  })
})

describe('writing the picked pair down', () => {
  it('survives the settings service being rebuilt over the same store', () => {
    const store = new MemorySettingsStore()
    rememberSelection({
      settings: serviceOver(store),
      selection: { modelId: 'claude-opus-5', effort: EEffort.High },
    })

    expect(
      launchSelection({ requested: NOTHING, remembered: serviceOver(store).snapshot().document }),
    ).toEqual({ modelId: 'claude-opus-5', effort: EEffort.High })
  })

  it('leaves every other setting in the file alone', () => {
    const store = new MemorySettingsStore({ document: { values: { 'appearance.accent': 'moss' } } })
    const settings = serviceOver(store)

    rememberSelection({ settings, selection: { modelId: 'claude-sonnet-5', effort: EEffort.Low } })

    expect(store.document().values).toEqual({
      'appearance.accent': 'moss',
      [REMEMBERED_MODEL_ID]: 'claude-sonnet-5',
      [REMEMBERED_EFFORT]: EEffort.Low,
    })
  })
})
