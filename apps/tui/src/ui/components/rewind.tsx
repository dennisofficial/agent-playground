import React from 'react'

import { fitHints, hintSpans, hintWidth, type Hint } from '../hint-layout'
import { type PressHandlers, usePress } from '../hooks/use-press'
import {
  CURRENT_LABEL,
  ERewindVerb,
  isCurrentRow,
  NO_UNDO,
  pointConsequence,
  pointLabel,
  REWIND_ROWS,
  rewindWindow,
  ROW_LINE_BUDGET,
  selectedPoint,
  VERB_LABEL,
  verbConsequence,
  verbsFor,
  verbTally,
  type RewindChoice,
  type RewindState,
} from '../rewind-model'
import { glyph, theme } from '../theme'
import { drawerCells, DrawerLine, DRAWER_INSET, SideDrawer } from './drawer'
import { clipSpans, truncateCells, wrapCells } from './sidebar/cells'
import { Row } from './sidebar/row'
import { Spans, type Span } from './spans'

const GUTTER_CELLS = 2

export const REWIND_INSET = DRAWER_INSET

export const rewindCells = (args: { width: number }): number => drawerCells(args)

export const HEADING = 'Rewind'

export const SUBTITLE =
  'Rewind the conversation to an earlier point. Files are left as they are.'

const BLANK_MESSAGE = '(blank message)'

const GUTTER = ' '.repeat(GUTTER_CELLS)

const inner = (cells: number): number => Math.max(1, cells - GUTTER_CELLS)

function budgeted(args: { text: string; cells: number; lines: number }): string[] {
  const wrapped = wrapCells({ text: args.text, cells: args.cells })
  if (wrapped.length <= args.lines) return wrapped

  const kept = wrapped.slice(0, args.lines)
  return [...kept.slice(0, -1), truncateCells({ text: `${kept.at(-1) ?? ''}…`, cells: args.cells })]
}

function Rows(props: {
  lines: readonly string[]
  cells: number
  fg: string
  gutter?: boolean
  head?: Span
}): React.ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      {props.lines.map((line, index) => (
        <DrawerLine key={`${String(index)}-${line}`}>
          <text>
            <Spans
              spans={clipSpans({
                spans: [
                  ...(props.gutter === true
                    ? [index === 0 && props.head !== undefined ? props.head : { text: GUTTER }]
                    : []),
                  { text: line, fg: props.fg },
                ],
                cells: props.cells,
              })}
            />
          </text>
        </DrawerLine>
      ))}
    </box>
  )
}

function blockOf(args: {
  state: RewindState
  index: number
  cells: number
}): { lines: readonly string[]; secondary: string } {
  const point = args.state.points[args.index]
  const label = point === undefined ? CURRENT_LABEL : pointLabel({ point })

  return {
    lines: budgeted({
      text: label === '' ? BLANK_MESSAGE : label,
      cells: inner(args.cells),
      lines: ROW_LINE_BUDGET,
    }),
    secondary: pointConsequence({ state: args.state, index: args.index }),
  }
}

function Block(props: {
  state: RewindState
  index: number
  cells: number
  selected: boolean
}): React.ReactNode {
  const { lines, secondary } = blockOf(props)

  return (
    <box flexDirection="column" flexShrink={0}>
      <Rows
        lines={lines}
        cells={props.cells}
        fg={props.selected ? theme.bright : theme.body}
        gutter
        {...(props.selected ? { head: { text: `${glyph.selected} `, fg: theme.accent } } : {})}
      />
      <Rows
        lines={budgeted({ text: secondary, cells: inner(props.cells), lines: ROW_LINE_BUDGET })}
        cells={props.cells}
        fg={theme.hint}
        gutter
      />
    </box>
  )
}

const CHOOSING: readonly Hint[] = [
  { key: 'Enter', label: 'to continue' },
  { key: 'Esc', label: 'to cancel' },
]

const COMMITTING: readonly Hint[] = [
  { key: 'Enter', label: 'to confirm' },
  { key: 'Esc', label: 'to go back' },
]

function footerHints(args: { hints: readonly Hint[]; cells: number }): readonly Hint[] {
  if (hintWidth(args.hints) <= args.cells) return args.hints

  return fitHints({ hints: [...args.hints].reverse(), cells: args.cells })
}

function Footer(props: {
  cells: number
  hints: readonly Hint[]
  press: PressHandlers
}): React.ReactNode {
  return (
    <DrawerLine press={props.press}>
      <text>
        <Spans
          spans={clipSpans({
            spans: hintSpans({
              hints: footerHints({ hints: props.hints, cells: props.cells }),
              keyColour: theme.meta,
            }),
            cells: props.cells,
          })}
        />
      </text>
    </DrawerLine>
  )
}

function Choosing(props: { state: RewindState; cells: number }): React.ReactNode {
  const { start, visible, below } = rewindWindow({ state: props.state, rows: REWIND_ROWS })

  return (
    <box flexDirection="column" flexShrink={0} gap={1}>
      {start === 0 ? null : (
        <Rows lines={[`↑ ${start} more above`]} cells={props.cells} fg={theme.meta} />
      )}
      {visible.map((point, offset) => (
        <Block
          key={point.seq}
          state={props.state}
          index={start + offset}
          cells={props.cells}
          selected={start + offset === props.state.index}
        />
      ))}
      {below === 0 ? null : (
        <Rows lines={[`↓ ${below} more below`]} cells={props.cells} fg={theme.meta} />
      )}
      <Block
        state={props.state}
        index={props.state.points.length}
        cells={props.cells}
        selected={isCurrentRow(props.state)}
      />
    </box>
  )
}

function Committing(props: {
  state: RewindState
  verb: ERewindVerb
  cells: number
  onPick: (choice: RewindChoice) => void
}): React.ReactNode {
  const press = usePress()
  const point = selectedPoint(props.state)
  const chosen = blockOf({ state: props.state, index: props.state.index, cells: props.cells })

  return (
    <box flexDirection="column" flexShrink={0} gap={1}>
      <Rows lines={chosen.lines} cells={props.cells} fg={theme.bright} gutter />
      <box flexDirection="column" flexShrink={0}>
        {verbsFor({ state: props.state }).map((verb) => (
          <DrawerLine
            key={verb}
            press={press(point === null ? undefined : () => props.onPick({ point, verb }))}
          >
            <Row
              label={VERB_LABEL[verb]}
              labelFg={verb === props.verb ? theme.bright : theme.body}
              cells={props.cells}
              mark={{ text: verb === props.verb ? glyph.selected : ' ', fg: theme.accent }}
              value={[{ text: verbTally({ state: props.state, verb }), fg: theme.hint }]}
            />
          </DrawerLine>
        ))}
      </box>
      <Rows
        lines={wrapCells({
          text: `${verbConsequence({ state: props.state, verb: props.verb })} · ${NO_UNDO}`,
          cells: inner(props.cells),
        })}
        cells={props.cells}
        fg={theme.hint}
        gutter
        head={{ text: `${glyph.warning} `, fg: theme.warn }}
      />
    </box>
  )
}

export function Rewind(props: {
  width: number
  state: RewindState
  overlay?: boolean
  onPick: (choice: RewindChoice) => void
  onDismiss: () => void
}): React.ReactNode {
  const cells = rewindCells({ width: props.width })
  const press = usePress()
  const verb = props.state.verb
  const committing = verb !== null && selectedPoint(props.state) !== null

  return (
    <SideDrawer
      width={props.width}
      overlay={props.overlay === true}
      footer={
        <Footer
          cells={cells}
          hints={committing ? COMMITTING : CHOOSING}
          press={press(props.onDismiss)}
        />
      }
    >
      <box flexDirection="column" flexShrink={0}>
        <Rows lines={[HEADING]} cells={cells} fg={theme.bright} />
        {committing ? null : (
          <Rows lines={wrapCells({ text: SUBTITLE, cells })} cells={cells} fg={theme.hint} />
        )}
      </box>
      {verb === null || !committing ? (
        <Choosing state={props.state} cells={cells} />
      ) : (
        <Committing state={props.state} verb={verb} cells={cells} onPick={props.onPick} />
      )}
    </SideDrawer>
  )
}
