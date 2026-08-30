import React from 'react'

import { fitHints, hintSpans, type Hint } from '../hint-layout'
import { type PressHandlers, usePress } from '../hooks/use-press'
import { glyph, theme } from '../theme'
import {
  matchingThreads,
  threadAge,
  threadsWindow,
  THREAD_ROWS,
  type ThreadRow,
  type ThreadsState,
} from '../threads-model'
import { clipSpans, spanCells } from './sidebar/cells'
import { Spans, type Span } from './spans'

const PAD = 2

const EDGE = 1

export const THREADS_INSET = EDGE + PAD * 2

export const threadsCells = (args: { width: number }): number =>
  Math.max(0, args.width - THREADS_INSET)

export const THREADS_HEADING = 'Conversations'

export const NO_THREADS = 'No other conversations here yet.'

export const NO_MATCHES = 'Nothing matches that.'

export const CURRENT_LABEL = '(current)'

const HINTS: readonly Hint[] = [
  { key: '↑↓', label: 'pick' },
  { key: '⏎', label: 'open' },
  { key: 'type', label: 'filter' },
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

function Header(props: { label: string }): React.ReactNode {
  return (
    <Line>
      <text fg={theme.meta}>{props.label.toUpperCase()}</text>
    </Line>
  )
}

function ThreadLine(props: {
  row: ThreadRow
  cells: number
  selected: boolean
  now: number
  press: PressHandlers
}): React.ReactNode {
  const band = props.selected ? { band: theme.hoverBg } : {}
  const age = threadAge({ updatedAt: props.row.updatedAt, now: props.now })
  const trailing = props.row.active ? CURRENT_LABEL : age

  const mark: Span = {
    text: `${props.row.active ? glyph.active : glyph.available} `,
    fg: props.row.active ? theme.accent : theme.hint,
  }

  const label: Span = {
    text: props.row.label,
    fg: props.selected ? theme.bright : props.row.titled ? theme.hover : theme.hint,
  }

  const right: Span = { text: trailing, fg: theme.hint }
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

export function Threads(props: {
  width: number
  state: ThreadsState
  overlay?: boolean
  onPick: (row: ThreadRow) => void
  onDismiss: () => void
}): React.ReactNode {
  const cells = threadsCells({ width: props.width })
  const press = usePress()
  const { state } = props
  const { start, visible, below } = threadsWindow({ state, rows: THREAD_ROWS })
  const empty = state.rows.length === 0
  const filteredOut = !empty && matchingThreads(state).length === 0

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
          <Header label={THREADS_HEADING} />
          <TextLine
            spans={[
              { text: `${glyph.marker} `, fg: theme.accent },
              state.query.length === 0
                ? { text: 'type to filter', fg: theme.hint }
                : { text: state.query, fg: theme.bright },
            ]}
            cells={cells}
          />
          {state.loading ? (
            <TextLine spans={[{ text: 'listing…', fg: theme.hint }]} cells={cells} />
          ) : null}
          {start === 0 ? null : (
            <TextLine spans={[{ text: `  ${start} more above`, fg: theme.hint }]} cells={cells} />
          )}
          {visible.map((row, offset) => (
            <ThreadLine
              key={row.threadId}
              row={row}
              cells={cells}
              now={state.openedAt}
              selected={start + offset === state.index}
              press={press(() => props.onPick(row))}
            />
          ))}
          {below === 0 ? null : (
            <TextLine spans={[{ text: `  ${below} more below`, fg: theme.hint }]} cells={cells} />
          )}
          {!state.loading && empty ? (
            <TextLine spans={[{ text: NO_THREADS, fg: theme.hint }]} cells={cells} />
          ) : null}
          {filteredOut ? (
            <TextLine spans={[{ text: NO_MATCHES, fg: theme.hint }]} cells={cells} />
          ) : null}
        </box>
        {state.failure === null ? null : (
          <TextLine spans={[{ text: state.failure, fg: theme.warn }]} cells={cells} />
        )}
      </box>
      <TextLine
        spans={hintSpans({ hints: fitHints({ hints: HINTS, cells }), keyColour: theme.meta })}
        cells={cells}
        press={press(props.onDismiss)}
      />
    </box>
  )
}
