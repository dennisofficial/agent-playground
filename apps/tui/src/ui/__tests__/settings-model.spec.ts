import {
  ATLAS_SETTINGS,
  ESettingId,
  ESettingsLayer,
  resolveSettings,
  type SettingsLayerInput,
} from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import {
  currentRow,
  movePage,
  moveRow,
  openSettings,
  settingsModel,
  type SettingsModel,
} from '../settings-model'

const modelWith = (layers: readonly SettingsLayerInput[] = []): SettingsModel =>
  settingsModel({
    definitions: ATLAS_SETTINGS,
    resolution: resolveSettings({ definitions: ATLAS_SETTINGS, layers }),
  })

describe('settingsModel', () => {
  it('keeps only the pages that have something on them', () => {
    const model = modelWith()

    expect(model.pages.map((page) => page.page.label)).toEqual(['general', 'appearance'])
  })

  it('gathers consecutive rows under one group heading', () => {
    const general = modelWith().pages[0]

    expect(general?.groups.map((group) => [group.label, group.rows.length])).toEqual([
      ['Transcript', 5],
      ['Layout', 2],
      ['Project context', 5],
      ['Context window', 1],
      ['Worktrees', 1],
      ['Usage meters', 3],
      ['Nudges', 1],
      ['Notifications', 1],
      ['Web', 2],
      ['Model', 2],
    ])
    expect(general?.rows).toHaveLength(23)
  })

  it('keeps the appearance page to its colour, its density and its composer', () => {
    const appearance = modelWith().pages[1]

    expect(appearance?.groups.map((group) => group.label)).toEqual([
      'Colour',
      'Density',
      'Composer',
    ])
    expect(appearance?.rows).toHaveLength(3)
  })

  it('carries where each value came from onto the row', () => {
    const model = modelWith([
      {
        layer: ESettingsLayer.Environment,
        origin: 'environment',
        values: { [ESettingId.Accent]: 'moss' },
        origins: { [ESettingId.Accent]: 'ATLAS_ACCENT' },
      },
    ])
    const appearance = model.pages[1]

    expect(appearance?.rows[0]?.value).toBe('moss')
    expect(appearance?.rows[0]?.origin).toBe('ATLAS_ACCENT')
  })
})

describe('moving around the page', () => {
  const model = modelWith()

  it('stops at the ends of a page rather than wrapping rows', () => {
    const top = openSettings()

    expect(moveRow({ state: top, model, delta: -1 })).toEqual({ pageIndex: 0, rowIndex: 0 })
    expect(moveRow({ state: top, model, delta: 99 })).toEqual({ pageIndex: 0, rowIndex: 22 })
  })

  it('wraps around the tab strip and lands on its first row', () => {
    const moved = movePage({ state: { pageIndex: 0, rowIndex: 1 }, model, delta: 1 })

    expect(moved).toEqual({ pageIndex: 1, rowIndex: 0 })
    expect(movePage({ state: moved, model, delta: 1 })).toEqual({ pageIndex: 0, rowIndex: 0 })
    expect(movePage({ state: openSettings(), model, delta: -1 })).toEqual({
      pageIndex: 1,
      rowIndex: 0,
    })
  })

  it('names the row the keys would act on', () => {
    expect(currentRow({ state: openSettings(), model })?.definition.id).toBe(
      ESettingId.SmoothStreaming,
    )
    expect(currentRow({ state: { pageIndex: 1, rowIndex: 0 }, model })?.definition.id).toBe(
      ESettingId.Accent,
    )
  })
})
