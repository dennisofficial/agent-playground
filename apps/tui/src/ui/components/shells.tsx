import React from 'react'

import type { ShellSnapshot } from '@dltech/atlas-harness'

import { fitHints, hintSpans, type Hint } from '../hint-layout'
import type { OutputScroll } from '../hooks/use-output-scroll'
import { usePress, type PressHandlers } from '../hooks/use-press'
import {
  AWAITING_INPUT_LABEL,
  isShellRunning,
  outputRows,
  shellCommandLabel,
  shellNameLabel,
  shellStateLabel,
} from '../shells-model'
import { glyph, theme } from '../theme'
import { clipSpans } from './sidebar/cells'
import { Spans, type Span } from './spans'

const PAD = 2

const EDGE = 1

export const SHELLS_INSET = EDGE + PAD * 2

export const shellsCells = (args: { width: number }): number =>
  Math.max(0, args.width - SHELLS_INSET)

/**
 * How far back the panel lets a reader walk. The registry retains more than this, but every row is
 * a renderable that the tail rewrites as output lands, so the scrollback is bounded by what a reader
 * would ever page through rather than by what is kept.
 */
const SCROLLBACK_ROWS = 1_000

const SCROLLBAR_COLUMN = 1

const NOTHING_PRINTED = 'It has printed nothing yet.'

const BACK_TO_END = 'back to the end'

const STDIN_CLOSED =
  'Its stdin is closed, so nothing can answer it. Kill it and re-run with input piped in.'

function Line(props: {
  band?: string | undefined
  press?: PressHandlers | undefined
  children: React.ReactNode
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

function GroupHeader(props: { label: string; count?: string; note?: string }): React.ReactNode {
  return (
    <Line>
      <text>
        <Spans
          spans={[
            { text: props.label.toUpperCase(), fg: theme.meta },
            ...(props.count === undefined ? [] : [{ text: `  ${props.count}`, fg: theme.hint }]),
            ...(props.note === undefined ? [] : [{ text: `  ${props.note}`, fg: theme.warn }]),
          ]}
        />
      </text>
    </Line>
  )
}

function markOf(shell: ShellSnapshot): Span {
  if (shell.awaitingInput) return { text: glyph.warning, fg: theme.warn }
  if (isShellRunning(shell)) return { text: glyph.active, fg: theme.ok }
  return { text: glyph.seen, fg: theme.rule }
}

const named = (shell: ShellSnapshot): boolean => (shell.description?.trim() ?? '') !== ''

function ShellHeading(props: { shell: ShellSnapshot; cells: number }): React.ReactNode {
  const { shell } = props
  const state = shell.awaitingInput ? AWAITING_INPUT_LABEL : shellStateLabel(shell)

  const spans: Span[] = [
    markOf(shell),
    { text: ' ' },
    { text: shell.shellId, fg: theme.bright },
    { text: '  ' },
    { text: shellNameLabel(shell), fg: theme.hover },
    { text: '  ' },
    { text: state, fg: shell.awaitingInput ? theme.warn : theme.meta },
    ...(named(shell) ? [{ text: '  ' }, { text: shellCommandLabel(shell.command), fg: theme.dim }] : []),
  ]

  return (
    <Line band={theme.panelBg}>
      <text>
        <Spans spans={clipSpans({ spans, cells: props.cells })} />
      </text>
    </Line>
  )
}

const KILL_AFFORDANCE = 'stop it'

function OutputSection(props: {
  shell: ShellSnapshot
  output: string
  cells: number
  press: PressHandlers
  jumpPress: PressHandlers
  scroll?: OutputScroll | undefined
}): React.ReactNode {
  const wrapCells = Math.max(0, props.cells - SCROLLBAR_COLUMN)
  const rows = outputRows({ text: props.output, cells: wrapCells, limit: SCROLLBACK_ROWS })
  const scroll = props.scroll
  const scrolledBack = scroll !== undefined && !scroll.pinned

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      <GroupHeader
        label="Output"
        count={`${props.shell.totalCharacters} chars`}
        {...(scrolledBack ? { note: 'scrolled back' } : {})}
      />
      {isShellRunning(props.shell) ? (
        <Line press={props.press}>
          <text>
            <Spans
              spans={[
                { text: `${glyph.failed} `, fg: theme.warn },
                { text: KILL_AFFORDANCE, fg: theme.hover },
              ]}
            />
          </text>
        </Line>
      ) : null}
      {props.shell.awaitingInput ? (
        <Line>
          <text>
            <Spans spans={clipSpans({ spans: [{ text: STDIN_CLOSED, fg: theme.warn }], cells: props.cells })} />
          </text>
        </Line>
      ) : null}
      {rows.length === 0 ? (
        <Line>
          <text fg={theme.meta}>{NOTHING_PRINTED}</text>
        </Line>
      ) : (
        <scrollbox
          {...(scroll === undefined ? {} : { ref: scroll.attach })}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          focusable={false}
          stickyScroll
          stickyStart="bottom"
          viewportCulling
        >
          {rows.map((row, index) => (
            <Line key={index}>
              <text fg={theme.hover}>{row}</text>
            </Line>
          ))}
        </scrollbox>
      )}
      {scrolledBack ? (
        <Line press={props.jumpPress}>
          <text fg={theme.warn}>{`↓ ${BACK_TO_END}`}</text>
        </Line>
      ) : null}
    </box>
  )
}

const WALKING: readonly Hint[] = [
  { key: '↑↓', label: 'pick' },
  { key: 'pgup/pgdn', label: 'scroll' },
  { key: 'k', label: 'kill' },
  { key: 'esc', label: 'close' },
]

function FooterLine(props: { cells: number; press: PressHandlers }): React.ReactNode {
  const spans = hintSpans({
    hints: fitHints({ hints: WALKING, cells: props.cells }),
    keyColour: theme.meta,
  })

  return (
    <Line press={props.press}>
      <text>
        <Spans spans={clipSpans({ spans, cells: props.cells })} />
      </text>
    </Line>
  )
}

export function Shells(props: {
  width: number
  shells: readonly ShellSnapshot[]
  selected: ShellSnapshot | undefined
  output: string
  scroll?: OutputScroll | undefined
  overlay?: boolean
  onKill: (shellId: string) => void
  onDismiss: () => void
}): React.ReactNode {
  const cells = shellsCells({ width: props.width })
  const press = usePress()
  const running = props.shells.filter(isShellRunning).length
  const selected = props.selected

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={props.width}
      backgroundColor={theme.overlayBg}
      border={['right']}
      borderColor={theme.rule}
      paddingTop={1}
      paddingBottom={1}
      {...(props.overlay
        ? { position: 'absolute' as const, top: 0, bottom: 0, left: 0, zIndex: 20 }
        : {})}
    >
      <box flexDirection="column" flexGrow={1} flexShrink={1} gap={1}>
        {selected === undefined ? (
          <box flexDirection="column" flexShrink={0}>
            <GroupHeader label="Background shells" count={`${running}/${props.shells.length}`} />
            <Line>
              <text fg={theme.meta}>Nothing is running in the background.</text>
            </Line>
          </box>
        ) : (
          <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
            <GroupHeader label="Shell log" count={`${running}/${props.shells.length}`} />
            <ShellHeading shell={selected} cells={cells} />
            <OutputSection
              shell={selected}
              output={props.output}
              cells={cells}
              press={press(() => props.onKill(selected.shellId))}
              jumpPress={press(props.scroll?.handleJumpToEnd)}
              {...(props.scroll === undefined ? {} : { scroll: props.scroll })}
            />
          </box>
        )}
      </box>
      <FooterLine cells={cells} press={press(props.onDismiss)} />
    </box>
  )
}
