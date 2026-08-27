import {
  ATLAS_SETTINGS,
  ESettingId,
  ESettingsLayer,
  resolveSettings,
  type SettingsLayerInput,
} from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { Settings, settingsDetailVisible } from '../components/settings'
import { cellsOf } from '../hint-layout'
import { grammarsReady } from '../markdown/__tests__/harness'
import { OPTION_SEPARATOR, RANGE_HINT, TOGGLE_HINT } from '../settings-format'
import { settingsModel, type SettingsState } from '../settings-model'
import { glyph, SIDEBAR_WIDTH } from '../theme'
import { frameOf } from './transcript-fixture'

await grammarsReady()

const WIDE = 120

const NARROW = 88

const ORIGIN = '~/.atlas/settings.json'

const page = (args: {
  width?: number
  sidebarWidth?: number
  state?: SettingsState
  layers?: readonly SettingsLayerInput[]
  problem?: string
}): React.ReactNode => {
  const resolution = resolveSettings({ definitions: ATLAS_SETTINGS, layers: args.layers ?? [] })

  return (
    <Settings
      width={args.width ?? WIDE}
      sidebarWidth={args.sidebarWidth ?? SIDEBAR_WIDTH}
      model={settingsModel({ definitions: ATLAS_SETTINGS, resolution })}
      state={args.state ?? { pageIndex: 0, rowIndex: 0 }}
      cwd="/Users/dennis/Developer/atlas"
      origin={ORIGIN}
      {...(args.problem === undefined ? {} : { problem: args.problem })}
      onActivate={() => {}}
      onDismiss={() => {}}
    />
  )
}

const rowsOf = async (node: React.ReactNode, width: number): Promise<string[]> =>
  (await frameOf(node, width)).split('\n')

const rowWith = (rows: readonly string[], needle: string): string =>
  rows.find((row) => row.includes(needle)) ?? ''

describe('the settings page', () => {
  it('names itself and the page it is on', async () => {
    const head = (await rowsOf(page({}), WIDE))[0] ?? ''

    expect(head).toContain(`${glyph.block} settings`)
    expect(head).toContain('general')
    expect(head).toContain('appearance')
    expect(head).toContain(ORIGIN)
  })

  it('heads each group and lists its rows', async () => {
    const rows = await rowsOf(page({}), WIDE)

    expect(rowWith(rows, 'TRANSCRIPT')).not.toBe('')
    expect(rowWith(rows, 'LAYOUT')).not.toBe('')
    expect(rowWith(rows, 'Smooth streaming')).toContain('on')
    expect(rowWith(rows, 'Sidebar width')).toContain('42 cols')
  })

  it('says what each kind of row responds to', async () => {
    const rows = await rowsOf(page({}), WIDE)

    expect(rowWith(rows, 'Smooth streaming')).toContain(TOGGLE_HINT)
    expect(rowWith(rows, 'Sidebar width')).toContain(RANGE_HINT)
    expect(rowWith(rows, 'Accent')).toBe('')
  })

  it('lists the options a choice offers', async () => {
    const rows = await rowsOf(page({ state: { pageIndex: 1, rowIndex: 0 } }), WIDE)

    expect(rowWith(rows, 'Accent')).toContain(
      ['clay', 'slate', 'moss', 'plum'].join(OPTION_SEPARATOR),
    )
  })

  it('marks the selected row and only that row', async () => {
    const rows = await rowsOf(page({ state: { pageIndex: 0, rowIndex: 2 } }), WIDE)
    const marked = rows.filter((row) => row.includes(glyph.selected))

    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain('Sidebar width')
  })

  it('explains the selected row and where its value came from', async () => {
    const rows = await rowsOf(
      page({
        layers: [
          {
            layer: ESettingsLayer.Environment,
            origin: 'environment',
            values: { [ESettingId.SmoothStreaming]: 'off' },
            origins: { [ESettingId.SmoothStreaming]: 'ATLAS_SMOOTH_STREAMING' },
          },
        ],
      }),
      WIDE,
    )

    expect(rowWith(rows, 'SMOOTH STREAMING')).not.toBe('')
    expect(rowWith(rows, 'Reveal assistant text')).not.toBe('')
    expect(rowWith(rows, 'SET BY')).not.toBe('')
    expect(rowWith(rows, 'environment · ATLAS_SMOOTH_STREAMING')).not.toBe('')
  })

  it('says where edits land, and says instead what went wrong', async () => {
    expect(rowWith(await rowsOf(page({}), WIDE), 'edits write to')).toContain(ORIGIN)
    expect(rowWith(await rowsOf(page({ problem: 'read-only' }), WIDE), 'read-only')).not.toBe('')
  })

  it('offers the keys that move around it', async () => {
    const rows = await rowsOf(page({}), WIDE)
    const footer = rowWith(rows, 'edits write to')

    expect(footer).toContain('↑↓')
    expect(footer).toContain('⇥')
    expect(footer).toContain('esc')
  })

  it('drops the explanation pane rather than the rows when the terminal is narrow', async () => {
    const rows = await rowsOf(page({ width: NARROW }), NARROW)

    expect(settingsDetailVisible({ width: NARROW, sidebarWidth: SIDEBAR_WIDTH })).toBe(false)
    expect(rowWith(rows, 'Smooth streaming')).not.toBe('')
    expect(rowWith(rows, 'SET BY')).toBe('')
  })

  it('gives the explanation pane exactly the sidebar width it was handed', async () => {
    for (const sidebarWidth of [SIDEBAR_WIDTH, 56]) {
      const rows = await rowsOf(page({ sidebarWidth }), WIDE)

      expect(rowWith(rows, 'SET BY').indexOf('SET BY')).toBe(WIDE - sidebarWidth + 2)
    }
  })

  it('drops the pane once it would leave the rows no room, however wide the terminal', async () => {
    const rows = await rowsOf(page({ sidebarWidth: 70 }), WIDE)

    expect(settingsDetailVisible({ width: WIDE, sidebarWidth: 70 })).toBe(false)
    expect(rowWith(rows, 'Smooth streaming')).not.toBe('')
    expect(rowWith(rows, 'SET BY')).toBe('')
  })

  it('keeps every row inside the terminal at any width', async () => {
    for (const width of [NARROW, 100, WIDE, 200]) {
      for (const row of await rowsOf(page({ width }), width)) {
        expect(cellsOf(row.trimEnd())).toBeLessThanOrEqual(width)
      }
    }
  })
})
