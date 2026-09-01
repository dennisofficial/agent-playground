import React from 'react'

import { fitHints, hintSpans, type Hint } from '../hint-layout'
import { usePress } from '../hooks/use-press'
import { currentPage, type SettingsModel, type SettingsState } from '../settings-model'
import { theme } from '../theme'
import type { Appearance } from '../appearance'
import { SettingsBand } from './settings/band'
import { SettingsDetail } from './settings/detail'
import { SettingsHead } from './settings/head'
import { SettingLine, SettingsGroupHeader, SettingsLine, SETTINGS_PAD } from './settings/rows'
import { clipSpans } from './sidebar/cells'
import { Spans, type Span } from './spans'

export const SETTINGS_ROWS_MIN_CELLS = 60

const HINTS: readonly Hint[] = [
  { key: '↑↓', label: 'row' },
  { key: '⏎', label: 'set' },
  { key: '⇥', label: 'tab' },
  { key: 'esc', label: 'back' },
]

const GAP_CELLS = 1

const settingsCells = (args: { width: number }): number =>
  Math.max(0, args.width - SETTINGS_PAD * 2)

export const settingsDetailVisible = (args: { width: number; sidebarWidth: number }): boolean =>
  args.width - args.sidebarWidth >= SETTINGS_ROWS_MIN_CELLS

function FooterLine(props: {
  cells: number
  status: string
  failing: boolean
  onDismiss: () => void
}): React.ReactNode {
  const press = usePress()
  const hints = hintSpans({
    hints: fitHints({ hints: HINTS, cells: props.cells }),
    keyColour: theme.meta,
  })
  const width = hints.reduce((total, span) => total + [...span.text].length, 0)
  const status: Span = {
    text: props.status,
    fg: props.failing ? theme.error : theme.meta,
  }
  const gap = Math.max(GAP_CELLS, props.cells - [...props.status].length - width)

  return (
    <SettingsLine press={press(props.onDismiss)}>
      <text>
        <Spans
          spans={clipSpans({ spans: [status, { text: ' '.repeat(gap) }, ...hints], cells: props.cells })}
        />
      </text>
    </SettingsLine>
  )
}

export function Settings(props: {
  width: number
  sidebarWidth: number
  model: SettingsModel
  state: SettingsState
  cwd: string
  origin: string
  appearance: Appearance
  problem?: string | undefined
  onActivate: (target: { pageIndex: number; rowIndex: number }) => void
  onDismiss: () => void
}): React.ReactNode {
  const press = usePress()
  const detail = settingsDetailVisible({ width: props.width, sidebarWidth: props.sidebarWidth })
  const columnWidth = props.width - (detail ? props.sidebarWidth : 0)
  const cells = settingsCells({ width: columnWidth })
  const page = currentPage({ state: props.state, model: props.model })
  const selected = page?.rows[props.state.rowIndex]

  return (
    <box
      flexDirection="column"
      backgroundColor={theme.appBg}
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={30}
    >
      <SettingsHead
        cells={settingsCells({ width: props.width })}
        pages={props.model.pages.map((held) => held.page)}
        pageIndex={props.state.pageIndex}
        origin={props.origin}
      />
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0}>
        <box
          flexDirection="column"
          width={columnWidth}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          paddingTop={1}
        >
          <scrollbox flexGrow={1} flexShrink={1} flexBasis={0}>
            <box flexDirection="column" flexShrink={0} gap={1}>
              {page?.groups.map((group) => (
                <box key={group.label} flexDirection="column" flexShrink={0}>
                  <SettingsGroupHeader label={group.label} />
                  {group.rows.map((row) => (
                    <SettingLine
                      key={row.definition.id}
                      setting={row}
                      cells={cells}
                      selected={row.definition.id === selected?.definition.id}
                      press={press(() =>
                        props.onActivate({
                          pageIndex: props.state.pageIndex,
                          rowIndex: page.rows.indexOf(row),
                        }),
                      )}
                    />
                  ))}
                </box>
              ))}
            </box>
          </scrollbox>
          <SettingsBand
            width={columnWidth}
            setting={selected}
            appearance={props.appearance}
          />
          <FooterLine
            cells={cells}
            status={props.problem ?? `edits write to ${props.origin}`}
            failing={props.problem !== undefined}
            onDismiss={props.onDismiss}
          />
        </box>
        {detail ? (
          <SettingsDetail width={props.sidebarWidth} setting={selected} cwd={props.cwd} />
        ) : null}
      </box>
    </box>
  )
}
