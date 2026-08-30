import React from 'react'

import { providerSpec } from '@dltech/atlas-core'

import {
  accountDetail,
  EAccountsView,
  maskedKey,
  type AccountRow,
  type AccountsState,
} from '../accounts-model'
import { fitHints, hintSpans, type Hint } from '../hint-layout'
import { type PressHandlers, usePress } from '../hooks/use-press'
import { glyph, theme } from '../theme'
import { clipSpans } from './sidebar/cells'
import { Spans, type Span } from './spans'

const PAD = 2

const EDGE = 1

export const ACCOUNTS_INSET = EDGE + PAD * 2

export const accountsCells = (args: { width: number }): number =>
  Math.max(0, args.width - ACCOUNTS_INSET)

export const ACCOUNTS_HEADING = 'Accounts'

export const NO_ACCOUNTS = 'No accounts yet. Sign in to start a turn.'

const LIST_HINTS: readonly Hint[] = [
  { key: '↑↓', label: 'pick' },
  { key: '⏎', label: 'use' },
  { key: 'n', label: 'sign in' },
  { key: 'k', label: 'api key' },
  { key: 'x', label: 'remove' },
  { key: 'esc', label: 'close' },
]

const PROMPT_HINTS: readonly Hint[] = [
  { key: '⏎', label: 'submit' },
  { key: 'esc', label: 'cancel' },
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

function AccountLine(props: {
  row: AccountRow
  cells: number
  selected: boolean
  meters: readonly Span[]
  press: PressHandlers
}): React.ReactNode {
  const band = props.selected ? { band: theme.hoverBg } : {}

  return (
    <>
      <Line {...band} press={props.press}>
        <text>
          <Spans
            spans={clipSpans({
              spans: [
                {
                  text: `${props.row.active ? glyph.active : glyph.available} `,
                  fg: props.row.active ? theme.accent : theme.hint,
                },
                {
                  text: props.row.account.label,
                  fg: props.selected ? theme.bright : theme.hover,
                },
              ],
              cells: props.cells,
            })}
          />
        </text>
      </Line>
      <Line {...band} press={props.press}>
        <text>
          <Spans
            spans={clipSpans({
              spans: [
                { text: `  ${accountDetail(props.row.account)}`, fg: theme.hint },
                ...(props.meters.length === 0
                  ? []
                  : [{ text: '  ', fg: theme.hint }, ...props.meters]),
              ],
              cells: props.cells,
            })}
          />
        </text>
      </Line>
    </>
  )
}

function wrap(args: { text: string; cells: number }): readonly string[] {
  if (args.cells <= 0) return [args.text]

  return args.text.split('\n').flatMap((paragraph) => {
    const lines: string[] = []
    let rest = paragraph

    while (rest.length > args.cells) {
      const broke = rest.lastIndexOf(' ', args.cells)
      const at = broke > 0 ? broke : args.cells
      lines.push(rest.slice(0, at))
      rest = rest.slice(broke > 0 ? at + 1 : at)
    }
    lines.push(rest)

    return lines
  })
}

function Wrapped(props: { text: string; cells: number; fg: string }): React.ReactNode {
  const lines = wrap({ text: props.text, cells: props.cells })

  return (
    <>
      {lines.map((line, index) => (
        <Line key={`${index}-${line}`}>
          <text fg={props.fg}>{line}</text>
        </Line>
      ))}
    </>
  )
}

function Prompt(props: { state: AccountsState; cells: number }): React.ReactNode {
  const { state } = props
  const provider = state.prompt === null ? null : providerSpec(state.prompt.provider).label
  const typing = state.view === EAccountsView.ApiKey ? maskedKey(state.typed) : state.typed

  return (
    <box flexDirection="column" flexShrink={0}>
      <Header label={state.view === EAccountsView.ApiKey ? 'Paste the api key' : 'Sign in'} />
      {state.view === EAccountsView.ApiKey ? (
        <TextLine
          spans={[{ text: `Paste a ${provider ?? ''} api key and press enter.`, fg: theme.hint }]}
          cells={props.cells}
        />
      ) : (
        <>
          <TextLine
            spans={[{ text: 'Open this URL, approve, then paste the code:', fg: theme.hint }]}
            cells={props.cells}
          />
          <Wrapped text={state.prompt?.url ?? ''} cells={props.cells} fg={theme.court.external} />
        </>
      )}
      <TextLine
        spans={[
          { text: `${glyph.marker} `, fg: theme.accent },
          { text: typing.length === 0 ? 'waiting for a paste…' : typing, fg: theme.bright },
        ]}
        cells={props.cells}
      />
      {state.busy ? (
        <TextLine spans={[{ text: 'working…', fg: theme.hint }]} cells={props.cells} />
      ) : null}
    </box>
  )
}

export function Accounts(props: {
  meters?: (row: AccountRow) => readonly Span[]
  width: number
  state: AccountsState
  overlay?: boolean
  onPick: (row: AccountRow) => void
  onDismiss: () => void
}): React.ReactNode {
  const cells = accountsCells({ width: props.width })
  const press = usePress()
  const prompting = props.state.view !== EAccountsView.List

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
          <Header label={ACCOUNTS_HEADING} />
          {props.state.rows.length === 0 ? (
            <TextLine spans={[{ text: NO_ACCOUNTS, fg: theme.hint }]} cells={cells} />
          ) : (
            props.state.rows.map((row, index) => (
              <AccountLine
                key={row.account.id}
                row={row}
                cells={cells}
                meters={props.meters === undefined ? [] : props.meters(row)}
                selected={index === props.state.index && !prompting}
                press={press(() => props.onPick(row))}
              />
            ))
          )}
        </box>
        {prompting ? <Prompt state={props.state} cells={cells} /> : null}
        {props.state.notice === null ? null : (
          <box flexDirection="column" flexShrink={0}>
            <Wrapped text={props.state.notice} cells={cells} fg={theme.hint} />
          </box>
        )}
        {props.state.failure === null ? null : (
          <box flexDirection="column" flexShrink={0}>
            <Wrapped text={props.state.failure} cells={cells} fg={theme.warn} />
          </box>
        )}
      </box>
      <TextLine
        spans={hintSpans({
          hints: fitHints({ hints: prompting ? PROMPT_HINTS : LIST_HINTS, cells }),
          keyColour: theme.meta,
        })}
        cells={cells}
        press={press(props.onDismiss)}
      />
    </box>
  )
}
