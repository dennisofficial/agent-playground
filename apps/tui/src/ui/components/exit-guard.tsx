import React from 'react'

import {
  EXIT_GUARD_OPTIONS,
  type EExitChoice,
  type ExitGuardOption,
  type ExitGuardRow,
  type ExitGuardState,
} from '../exit-guard-model'
import { fitHints, hintSpans, type Hint } from '../hint-layout'
import { type PressHandlers, usePress } from '../hooks/use-press'
import { glyph, theme } from '../theme'
import { clipSpans, spanCells, truncateCells } from './sidebar/cells'
import { Spans, type Span } from './spans'

const PAD = 2

const EDGE = 1

const GUTTER_CELLS = 2

export const EXIT_GUARD_INSET = EDGE + PAD * 2

export const exitGuardCells = (args: { width: number }): number =>
  Math.max(0, args.width - EXIT_GUARD_INSET)

export const HEADING = 'Background work is running'

export const SUBTITLE = 'The following will stop when you exit:'

const SHELL_TAG = 'shell'

const TAG_SEPARATOR = ' · '

const GUTTER = ' '.repeat(GUTTER_CELLS)

const NOTE_GAP = '   '

const HINTS: readonly Hint[] = [
  { key: 'Enter', label: 'to confirm' },
  { key: 'Esc', label: 'to cancel' },
]

function Line(props: {
  spans: readonly Span[]
  cells: number
  press?: PressHandlers
}): React.ReactNode {
  return (
    <box height={1} flexShrink={0} paddingLeft={PAD} paddingRight={PAD} {...(props.press ?? {})}>
      <text>
        <Spans spans={clipSpans({ spans: props.spans, cells: props.cells })} />
      </text>
    </box>
  )
}

const Gap = (): React.ReactNode => <box height={1} flexShrink={0} />

function Shells(props: { running: readonly ExitGuardRow[]; cells: number }): React.ReactNode {
  if (props.running.length === 0) return null

  return (
    <box flexDirection="column" flexShrink={0}>
      <Gap />
      {props.running.map((row) => (
        <Line
          key={row.shellId}
          spans={shellSpans({ row, cells: props.cells })}
          cells={props.cells}
        />
      ))}
    </box>
  )
}

function shellSpans(args: { row: ExitGuardRow; cells: number }): Span[] {
  const tag: Span[] = [
    { text: SHELL_TAG, fg: theme.meta },
    { text: TAG_SEPARATOR, fg: theme.rule },
  ]

  return [
    ...tag,
    {
      text: truncateCells({
        text: args.row.label,
        cells: Math.max(0, args.cells - spanCells(tag)),
      }),
      fg: theme.body,
    },
  ]
}

function optionFg(args: { enabled: boolean; selected: boolean }): string {
  if (!args.enabled) return theme.hint
  if (args.selected) return theme.accent
  return theme.body
}

function optionSpans(args: {
  option: ExitGuardOption
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
      fg: optionFg({ enabled: args.option.enabled, selected: args.selected }),
    },
    ...(args.option.note === undefined
      ? []
      : [{ text: `${NOTE_GAP}(${args.option.note})`, fg: theme.dim }]),
  ]
}

/**
 * The guard rises from the bottom over the composer rather than taking a row in the transcript: the
 * question it asks is about leaving, not about anything the operator has read above it.
 */
export function ExitGuard(props: {
  width: number
  running: readonly ExitGuardRow[]
  state: ExitGuardState
  overlay?: boolean
  onPick: (choice: EExitChoice) => void
  onDismiss: () => void
}): React.ReactNode {
  const cells = exitGuardCells({ width: props.width })
  const press = usePress()

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={theme.overlayBg}
      border={['top']}
      borderColor={theme.rule}
      paddingTop={1}
      paddingBottom={1}
      {...(props.overlay
        ? { position: 'absolute' as const, left: 0, right: 0, bottom: 0, zIndex: 30 }
        : {})}
    >
      <Line spans={[{ text: HEADING, fg: theme.accent }]} cells={cells} />
      <Line spans={[{ text: SUBTITLE, fg: theme.hint }]} cells={cells} />
      <Shells running={props.running} cells={cells} />
      <Gap />
      {EXIT_GUARD_OPTIONS.map((option, index) => (
        <Line
          key={option.choice}
          spans={optionSpans({
            option,
            position: index + 1,
            selected: index === props.state.selected,
          })}
          cells={cells}
          press={press(option.enabled ? () => props.onPick(option.choice) : undefined)}
        />
      ))}
      <Gap />
      <Line
        spans={hintSpans({ hints: fitHints({ hints: HINTS, cells }), keyColour: theme.meta })}
        cells={cells}
        press={press(props.onDismiss)}
      />
    </box>
  )
}
