import React from 'react'

import {
  agentsWindow,
  AGENT_PICKER_ROWS,
  type AgentPickerRow,
  type AgentsPickerState,
} from '../agents-picker-model'
import { MARK_OF, NAME_INK_OF, STATE_INK_OF } from '../subagent-ink'
import { fitHints, hintSpans, type Hint } from '../hint-layout'
import { type PressHandlers, usePress } from '../hooks/use-press'
import { glyph, theme } from '../theme'
import { clipSpans, spanCells } from './sidebar/cells'
import { Spans, type Span } from './spans'

const PAD = 2

const EDGE = 1

export const AGENTS_PICKER_INSET = EDGE + PAD * 2

export const agentsPickerCells = (args: { width: number }): number =>
  Math.max(0, args.width - AGENTS_PICKER_INSET)

export const AGENTS_PICKER_HEADING = 'Sub-agents'

const HINTS: readonly Hint[] = [
  { key: '↑↓', label: 'pick' },
  { key: '⏎', label: 'read' },
  { key: 'esc', label: 'close' },
]

function Line(props: {
  children: React.ReactNode
  press?: PressHandlers
  band?: string
}): React.ReactNode {
  return (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={PAD}
      paddingRight={PAD}
      {...(props.band === undefined ? {} : { backgroundColor: props.band })}
      {...(props.press ?? {})}
    >
      {props.children}
    </box>
  )
}

function TextLine(props: {
  spans: readonly Span[]
  cells: number
  press?: PressHandlers
}): React.ReactNode {
  return (
    <Line {...(props.press === undefined ? {} : { press: props.press })}>
      <text>
        <Spans spans={clipSpans({ spans: props.spans, cells: props.cells })} />
      </text>
    </Line>
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
    <Line {...band} press={props.press}>
      <text>
        <Spans
          spans={clipSpans({
            spans: [mark, label, { text: ' '.repeat(gap), fg: theme.hint }, right],
            cells: props.cells,
          })}
        />
      </text>
    </Line>
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
    <box
      flexDirection="column"
      flexShrink={0}
      width={props.width}
      backgroundColor={theme.overlayBg}
      border={['left']}
      borderColor={theme.rule}
      paddingTop={1}
      paddingBottom={1}
      {...(props.overlay
        ? { position: 'absolute' as const, top: 0, bottom: 0, right: 0, zIndex: 20 }
        : {})}
    >
      <box flexDirection="column" flexGrow={1} flexShrink={1} gap={1}>
        <box flexDirection="column" flexShrink={0}>
          <Line>
            <text fg={theme.meta}>{AGENTS_PICKER_HEADING.toUpperCase()}</text>
          </Line>
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
      </box>
      <TextLine
        spans={hintSpans({ hints: fitHints({ hints: HINTS, cells }), keyColour: theme.meta })}
        cells={cells}
        press={press(props.onDismiss)}
      />
    </box>
  )
}
