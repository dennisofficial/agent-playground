import React from 'react'

import {
  APPROVAL_HEADING,
  APPROVAL_OPTIONS,
  type ApprovalOption,
  type ApprovalState,
  type EApprovalChoice,
} from '../approval-model'
import { type Hint } from '../hint-layout'
import { type PressHandlers, usePress } from '../hooks/use-press'
import { glyph, theme } from '../theme'
import { BottomDrawer, drawerCells, DrawerHints, DrawerLine, DRAWER_INSET } from './drawer'
import { clipSpans, wrapCells } from './sidebar/cells'
import { Spans, type Span } from './spans'

const GUTTER_CELLS = 2

const GUTTER = ' '.repeat(GUTTER_CELLS)

const REASON_LINES = 4

export const APPROVAL_INSET = DRAWER_INSET

export const approvalCells = (args: { width: number }): number => drawerCells(args)

const HINTS: readonly Hint[] = [
  { key: 'Enter', label: 'to proceed' },
  { key: 'Esc', label: 'to decline' },
  { key: '↑↓', label: 'to choose' },
]

function Line(props: {
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

const Gap = (): React.ReactNode => <box height={1} flexShrink={0} />

function Reason(props: { reason: string; cells: number }): React.ReactNode {
  const lines = wrapCells({ text: props.reason, cells: props.cells }).slice(0, REASON_LINES)

  return (
    <box flexDirection="column" flexShrink={0}>
      {lines.map((line, index) => (
        <Line key={`reason-${String(index)}`} spans={[{ text: line, fg: theme.body }]} cells={props.cells} />
      ))}
    </box>
  )
}

function optionSpans(args: {
  option: ApprovalOption
  position: number
  selected: boolean
}): Span[] {
  const mark: Span = args.selected
    ? { text: `${glyph.selected} `, fg: theme.accent }
    : { text: GUTTER }

  return [
    mark,
    {
      text: `${String(args.position)}. ${args.option.label}`,
      fg: args.selected ? theme.accent : theme.body,
    },
  ]
}

export function Approval(props: {
  width: number
  state: ApprovalState
  overlay?: boolean
  onPick: (choice: EApprovalChoice) => void
  onDismiss: () => void
}): React.ReactNode {
  const cells = approvalCells({ width: props.width })
  const press = usePress()

  return (
    <BottomDrawer overlay={props.overlay === true}>
      <Line spans={[{ text: APPROVAL_HEADING, fg: theme.accent }]} cells={cells} />
      <Gap />
      <Reason reason={props.state.reason} cells={cells} />
      <Gap />
      {APPROVAL_OPTIONS.map((option, index) => (
        <Line
          key={option.choice}
          spans={optionSpans({ option, position: index + 1, selected: index === props.state.selected })}
          cells={cells}
          press={press(() => props.onPick(option.choice))}
        />
      ))}
      <Gap />
      <DrawerHints hints={HINTS} cells={cells} onDismiss={props.onDismiss} />
    </BottomDrawer>
  )
}
