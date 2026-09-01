import React from 'react'

import { type Hint } from '../hint-layout'
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

export const THREADS_INSET = DRAWER_INSET

export const threadsCells = (args: { width: number }): number => drawerCells(args)

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
    <SideDrawer
      width={props.width}
      overlay={props.overlay === true}
      footer={<DrawerHints hints={HINTS} cells={cells} onDismiss={props.onDismiss} />}
    >
      <box flexDirection="column" flexShrink={0}>
        <DrawerHeading label={THREADS_HEADING} />
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
    </SideDrawer>
  )
}
