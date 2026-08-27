import React from 'react'

import { cellsOf } from '../hint-layout'
import { groupsOfBindings, useBoundKeys } from '../keys'
import { keyColumnCells, type Shortcut, type ShortcutGroup } from '../shortcuts'
import { theme } from '../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from './panel'
import { truncateCells } from './sidebar/cells'

const CHROME_COLUMNS = PANEL_INSET + PANEL_PAD

function KeyLine(props: { shortcut: Shortcut; keyCells: number; cells: number }): React.ReactNode {
  const pad = ' '.repeat(Math.max(1, props.keyCells - cellsOf(props.shortcut.key)))
  const label = truncateCells({
    text: props.shortcut.label,
    cells: Math.max(0, props.cells - props.keyCells),
  })

  return (
    <text>
      <span fg={theme.court.external}>{props.shortcut.key}</span>
      <span>{pad}</span>
      <span fg={theme.body}>{label}</span>
    </text>
  )
}

function Group(props: { group: ShortcutGroup; keyCells: number; cells: number }): React.ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.meta}>{props.group.title.toUpperCase()}</text>
      {props.group.shortcuts.map((shortcut) => (
        <KeyLine
          key={shortcut.key + shortcut.label}
          shortcut={shortcut}
          keyCells={props.keyCells}
          cells={props.cells}
        />
      ))}
    </box>
  )
}

export function Shortcuts(props: {
  width: number
  groups?: readonly ShortcutGroup[]
}): React.ReactNode {
  const bound = useBoundKeys()
  const groups = props.groups ?? groupsOfBindings(bound)
  const cells = Math.max(0, props.width - CHROME_COLUMNS)
  const keyCells = keyColumnCells(groups)

  return (
    <Panel
      width={props.width}
      fill={theme.overlayBg}
      label={<text fg={theme.meta} bg={theme.overlayBg}>{' Shortcuts '}</text>}
      badge={<text fg={theme.hint} bg={theme.overlayBg}>{' esc close '}</text>}
    >
      <box flexDirection="column" flexShrink={0} gap={1}>
        {groups.map((group) => (
          <Group key={group.title} group={group} keyCells={keyCells} cells={cells} />
        ))}
      </box>
    </Panel>
  )
}
