import React from 'react'

import {
  agentsWindow,
  AGENT_PICKER_ROWS,
  type AgentPickerRow,
  type AgentsPickerState,
} from '../agents-picker-model'
import { MARK_OF, NAME_INK_OF, STATE_INK_OF } from '../subagent-ink'
import { type Hint } from '../hint-layout'
import { type PressHandlers, usePress } from '../hooks/use-press'
import { theme } from '../theme'
import {
  drawerCells,
  DrawerHeading,
  DrawerHints,
  DrawerLine,
  DRAWER_INSET,
  SideDrawer,
} from './drawer'
import { clipSpans, spanCells } from './sidebar/cells'
import { Spans, type Span } from './spans'

export const AGENTS_PICKER_INSET = DRAWER_INSET

export const agentsPickerCells = (args: { width: number }): number => drawerCells(args)

export const AGENTS_PICKER_HEADING = 'Sub-agents'

const HINTS: readonly Hint[] = [
  { key: '↑↓', label: 'pick' },
  { key: '⏎', label: 'read' },
  { key: 'esc', label: 'close' },
]

function TextLine(props: {
  spans: readonly Span[]
  cells: number
  press?: PressHandlers
}): React.ReactNode {
  return (
    <DrawerLine {...(props.press === undefined ? {} : { press: props.press })}>
      <text>
        <Spans spans={clipSpans({ spans: props.spans, cells: props.cells })} />
      </text>
    </DrawerLine>
  )
}

function AgentLine(props: {
  row: AgentPickerRow
  cells: number
  selected: boolean
  press: PressHandlers
}): React.ReactNode {
  const band = props.selected ? { band: theme.hoverBg } : {}
  const marked = MARK_OF[props.row.tone]

  const mark: Span = { text: `${marked.text} `, fg: marked.fg }

  const label: Span = {
    text: props.row.name,
    fg: props.selected ? theme.bright : NAME_INK_OF[props.row.tone],
  }

  const right: Span = { text: props.row.state, fg: STATE_INK_OF[props.row.tone] }
  const gap = Math.max(1, props.cells - spanCells([mark, label, right]))

  return (
    <DrawerLine {...band} press={props.press}>
      <text>
        <Spans
          spans={clipSpans({
            spans: [mark, label, { text: ' '.repeat(gap), fg: theme.hint }, right],
            cells: props.cells,
          })}
        />
      </text>
    </DrawerLine>
  )
}

export function AgentsPicker(props: {
  width: number
  state: AgentsPickerState
  overlay?: boolean
  onPick: (row: AgentPickerRow) => void
  onDismiss: () => void
}): React.ReactNode {
  const cells = agentsPickerCells({ width: props.width })
  const press = usePress()
  const { start, visible, below } = agentsWindow({
    state: props.state,
    rows: AGENT_PICKER_ROWS,
  })

  return (
    <SideDrawer
      width={props.width}
      overlay={props.overlay === true}
      footer={<DrawerHints hints={HINTS} cells={cells} onDismiss={props.onDismiss} />}
    >
      <box flexDirection="column" flexShrink={0}>
        <DrawerHeading label={AGENTS_PICKER_HEADING} />
        {start === 0 ? null : (
          <TextLine spans={[{ text: `  ${start} more above`, fg: theme.hint }]} cells={cells} />
        )}
        {visible.map((row, offset) => (
          <AgentLine
            key={row.agentId}
            row={row}
            cells={cells}
            selected={start + offset === props.state.index}
            press={press(() => props.onPick(row))}
          />
        ))}
        {below === 0 ? null : (
          <TextLine spans={[{ text: `  ${below} more below`, fg: theme.hint }]} cells={cells} />
        )}
      </box>
    </SideDrawer>
  )
}
