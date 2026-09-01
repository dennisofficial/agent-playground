import React from 'react'

import type { ShellSnapshot } from '@dltech/atlas-harness'

import { type Hint } from '../hint-layout'
import type { OutputScroll } from '../hooks/use-output-scroll'
import { usePress, type PressHandlers } from '../hooks/use-press'
import {
  isShellRunning,
  outputRows,
  shellCommandLabel,
  shellNameLabel,
  shellReadout,
} from '../shells-model'
import { glyph, theme } from '../theme'
import {
  drawerCells,
  DrawerHints,
  DrawerLine,
  DRAWER_INSET,
  EDrawerEdge,
  SideDrawer,
} from './drawer'
import { clipSpans } from './sidebar/cells'
import { Spans, type Span } from './spans'

export const SHELLS_INSET = DRAWER_INSET

export const shellsCells = (args: { width: number }): number => drawerCells(args)

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

function GroupHeader(props: { label: string; count?: string; note?: string }): React.ReactNode {
  return (
    <DrawerLine>
      <text>
        <Spans
          spans={[
            { text: props.label.toUpperCase(), fg: theme.meta },
            ...(props.count === undefined ? [] : [{ text: `  ${props.count}`, fg: theme.hint }]),
            ...(props.note === undefined ? [] : [{ text: `  ${props.note}`, fg: theme.warn }]),
          ]}
        />
      </text>
    </DrawerLine>
  )
}

function markOf(shell: ShellSnapshot): Span {
  if (shell.awaitingInput) return { text: glyph.warning, fg: theme.warn }
  if (isShellRunning(shell)) return { text: glyph.active, fg: theme.ok }
  return { text: glyph.seen, fg: theme.rule }
}

const named = (shell: ShellSnapshot): boolean => (shell.description?.trim() ?? '') !== ''

function ShellHeading(props: {
  shell: ShellSnapshot
  now: number
  cells: number
}): React.ReactNode {
  const { shell } = props
  const state = shellReadout({ shell, now: props.now })

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
    <DrawerLine band={theme.panelBg}>
      <text>
        <Spans spans={clipSpans({ spans, cells: props.cells })} />
      </text>
    </DrawerLine>
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
        <DrawerLine press={props.press}>
          <text>
            <Spans
              spans={[
                { text: `${glyph.failed} `, fg: theme.warn },
                { text: KILL_AFFORDANCE, fg: theme.hover },
              ]}
            />
          </text>
        </DrawerLine>
      ) : null}
      {props.shell.awaitingInput ? (
        <DrawerLine>
          <text>
            <Spans spans={clipSpans({ spans: [{ text: STDIN_CLOSED, fg: theme.warn }], cells: props.cells })} />
          </text>
        </DrawerLine>
      ) : null}
      {rows.length === 0 ? (
        <DrawerLine>
          <text fg={theme.meta}>{NOTHING_PRINTED}</text>
        </DrawerLine>
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
            <DrawerLine key={index}>
              <text fg={theme.hover}>{row}</text>
            </DrawerLine>
          ))}
        </scrollbox>
      )}
      {scrolledBack ? (
        <DrawerLine press={props.jumpPress}>
          <text fg={theme.warn}>{`↓ ${BACK_TO_END}`}</text>
        </DrawerLine>
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

export function Shells(props: {
  width: number
  shells: readonly ShellSnapshot[]
  now: number
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
    <SideDrawer
      width={props.width}
      side={EDrawerEdge.Left}
      overlay={props.overlay === true}
      footer={<DrawerHints hints={WALKING} cells={cells} onDismiss={props.onDismiss} />}
    >
      {selected === undefined ? (
        <box flexDirection="column" flexShrink={0}>
          <GroupHeader label="Background shells" count={`${running}/${props.shells.length}`} />
          <DrawerLine>
            <text fg={theme.meta}>Nothing is running in the background.</text>
          </DrawerLine>
        </box>
      ) : (
        <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
          <GroupHeader label="Shell log" count={`${running}/${props.shells.length}`} />
          <ShellHeading shell={selected} now={props.now} cells={cells} />
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
    </SideDrawer>
  )
}
