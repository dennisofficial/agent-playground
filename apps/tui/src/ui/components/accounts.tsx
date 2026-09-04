import React from 'react'

import { providerSpec } from '@dltech/atlas-core'

import {
  ACCOUNT_ROWS,
  accountsWindow,
  EAccountsView,
  maskedKey,
  rowDetail,
  rowKey,
  rowLabel,
  type AccountRow,
  type AccountsState,
} from '../accounts-model'
import { type Hint } from '../hint-layout'
import { type PressHandlers, usePress } from '../hooks/use-press'
import { glyph, theme } from '../theme'
import { clipSpans } from './sidebar/cells'
import {
  BottomDrawer,
  drawerCells,
  DrawerGap,
  DrawerHeading,
  DrawerHints,
  DrawerLine,
  DRAWER_INSET,
} from './drawer'
import { Spans, type Span } from './spans'

export const ACCOUNTS_INSET = DRAWER_INSET

export const accountsCells = (args: { width: number }): number => drawerCells(args)

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
  { key: 'click', label: 'reopen url' },
  { key: 'esc', label: 'cancel' },
]

const DEVICE_HINTS: readonly Hint[] = [
  { key: 'click', label: 'reopen url' },
  { key: 'esc', label: 'cancel' },
]

export const OPEN_URL_HINT =
  'Opened in your browser. Approve, then paste the code. Click to reopen:'

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
      <DrawerLine {...band} press={props.press}>
        <text>
          <Spans
            spans={clipSpans({
              spans: [
                {
                  text: `${props.row.active ? glyph.active : glyph.available} `,
                  fg: props.row.active ? theme.accent : theme.hint,
                },
                {
                  text: rowLabel(props.row),
                  fg: props.selected ? theme.bright : theme.hover,
                },
              ],
              cells: props.cells,
            })}
          />
        </text>
      </DrawerLine>
      <DrawerLine {...band} press={props.press}>
        <text>
          <Spans
            spans={clipSpans({
              spans: [{ text: `  ${rowDetail(props.row)}`, fg: theme.hint }],
              cells: props.cells,
            })}
          />
        </text>
      </DrawerLine>
      {props.meters.length === 0 ? null : (
        <DrawerLine {...band} press={props.press}>
          <text>
            <Spans
              spans={clipSpans({
                spans: [{ text: '  ', fg: theme.hint }, ...props.meters],
                cells: props.cells,
              })}
            />
          </text>
        </DrawerLine>
      )}
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

function Wrapped(props: {
  text: string
  cells: number
  fg: string
  press?: PressHandlers
}): React.ReactNode {
  const lines = wrap({ text: props.text, cells: props.cells })

  return (
    <>
      {lines.map((line, index) => (
        <DrawerLine
          key={`${index}-${line}`}
          {...(props.press === undefined ? {} : { press: props.press })}
        >
          <text fg={props.fg}>{line}</text>
        </DrawerLine>
      ))}
    </>
  )
}

function Prompt(props: {
  state: AccountsState
  cells: number
  onOpenUrl: () => void
}): React.ReactNode {
  const { state } = props
  const press = usePress()
  const provider = state.prompt === null ? null : providerSpec(state.prompt.provider).label
  const typing = state.view === EAccountsView.ApiKey ? maskedKey(state.typed) : state.typed

  return (
    <box flexDirection="column" flexShrink={0}>
      <DrawerHeading
        label={state.view === EAccountsView.ApiKey ? 'Paste the api key' : 'Sign in'}
      />
      {state.view === EAccountsView.ApiKey ? (
        <TextLine
          spans={[{ text: `Paste a ${provider ?? ''} api key and press enter.`, fg: theme.hint }]}
          cells={props.cells}
        />
      ) : state.view === EAccountsView.DeviceCode ? (
        <>
          {state.prompt?.userCode === undefined || state.prompt.userCode.length === 0 ? (
            <TextLine
              spans={[{ text: 'Asking OpenAI for a code…', fg: theme.hint }]}
              cells={props.cells}
            />
          ) : (
            <>
              <TextLine
                spans={[
                  { text: 'Enter this code to sign in: ', fg: theme.hint },
                  { text: state.prompt.userCode, fg: theme.bright },
                ]}
                cells={props.cells}
              />
              <Wrapped
                text={state.prompt.url}
                cells={props.cells}
                fg={theme.court.external}
                press={press(props.onOpenUrl)}
              />
              <TextLine
                spans={[{ text: 'waiting for approval…', fg: theme.hint }]}
                cells={props.cells}
              />
            </>
          )}
        </>
      ) : (
        <>
          <TextLine
            spans={[{ text: OPEN_URL_HINT, fg: theme.hint }]}
            cells={props.cells}
            press={press(props.onOpenUrl)}
          />
          <Wrapped
            text={state.prompt?.url ?? ''}
            cells={props.cells}
            fg={theme.court.external}
            press={press(props.onOpenUrl)}
          />
        </>
      )}
      {state.view === EAccountsView.DeviceCode ? null : (
        <TextLine
          spans={[
            { text: `${glyph.marker} `, fg: theme.accent },
            { text: typing.length === 0 ? 'waiting for a paste…' : typing, fg: theme.bright },
          ]}
          cells={props.cells}
        />
      )}
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
  onOpenUrl: () => void
}): React.ReactNode {
  const cells = accountsCells({ width: props.width })
  const press = usePress()
  const prompting = props.state.view !== EAccountsView.List

  const { start, visible, below } = accountsWindow({ state: props.state, rows: ACCOUNT_ROWS })

  return (
    <BottomDrawer
      overlay={props.overlay === true}
      footer={
        <>
          <DrawerGap />
          <DrawerHints
            hints={
              prompting
                ? props.state.view === EAccountsView.DeviceCode
                  ? DEVICE_HINTS
                  : PROMPT_HINTS
                : LIST_HINTS
            }
            cells={cells}
            onDismiss={props.onDismiss}
          />
        </>
      }
    >
      <box flexDirection="column" flexShrink={0}>
        <DrawerHeading label={ACCOUNTS_HEADING} />
        {props.state.rows.length === 0 ? (
          <TextLine spans={[{ text: NO_ACCOUNTS, fg: theme.hint }]} cells={cells} />
        ) : (
          <>
            {start === 0 ? null : (
              <TextLine spans={[{ text: `  ${start} more above`, fg: theme.hint }]} cells={cells} />
            )}
            {visible.map((row, offset) => (
              <AccountLine
                key={rowKey(row)}
                row={row}
                cells={cells}
                meters={props.meters === undefined ? [] : props.meters(row)}
                selected={start + offset === props.state.index && !prompting}
                press={press(() => props.onPick(row))}
              />
            ))}
            {below === 0 ? null : (
              <TextLine spans={[{ text: `  ${below} more below`, fg: theme.hint }]} cells={cells} />
            )}
          </>
        )}
      </box>
      {prompting ? <Prompt state={props.state} cells={cells} onOpenUrl={props.onOpenUrl} /> : null}
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
    </BottomDrawer>
  )
}
