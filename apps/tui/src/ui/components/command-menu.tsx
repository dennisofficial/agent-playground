import React from 'react'

import { ECommandKind, qualifiedName, type CommandSpec } from '@dltech/atlas-core'

import {
  COMMAND_MENU_ROWS,
  commandMenuWindow,
  type CommandMenuState,
} from '../command-menu-model'
import { cellsOf } from '../hint-layout'
import { glyph, theme } from '../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from './panel'
import { clipSpans, truncateCells } from './sidebar/cells'
import { Spans, type Span } from './spans'

const CHROME_COLUMNS = PANEL_INSET + PANEL_PAD

const CARET_CELLS = 2

const GAP_CELLS = 2

export const KIND_MARK: Readonly<Record<ECommandKind, string>> = {
  [ECommandKind.Local]: 'cmd',
  [ECommandKind.Skill]: 'skill',
}

const labelOf = (spec: CommandSpec): string =>
  spec.argumentHint === undefined ? `/${spec.name}` : `/${spec.name} ${spec.argumentHint}`

const labelColumn = (specs: readonly CommandSpec[]): number =>
  specs.reduce((cells, spec) => Math.max(cells, cellsOf(labelOf(spec))), 0) + GAP_CELLS

const kindColour = (kind: ECommandKind): string =>
  kind === ECommandKind.Skill ? theme.court.external : theme.meta

function rowSpans(args: {
  spec: CommandSpec
  cells: number
  labelCells: number
  selected: boolean
}): Span[] {
  const band = args.selected ? { bg: theme.hoverBg } : {}
  const label = labelOf(args.spec)
  const padded = `${label}${' '.repeat(Math.max(0, args.labelCells - cellsOf(label)))}`
  const kind = KIND_MARK[args.spec.kind]
  const spent = CARET_CELLS + cellsOf(padded) + cellsOf(kind)
  const summary = truncateCells({
    text: args.spec.summary,
    cells: Math.max(0, args.cells - spent - GAP_CELLS),
  })
  const fill = ' '.repeat(Math.max(0, args.cells - spent - cellsOf(summary)))

  return clipSpans({
    spans: [
      { text: args.selected ? `${glyph.selected} ` : '  ', fg: theme.accent, ...band },
      { text: padded, fg: args.selected ? theme.bright : theme.hover, ...band },
      { text: summary, fg: theme.hint, ...band },
      { text: fill, ...band },
      { text: kind, fg: kindColour(args.spec.kind), ...band },
    ],
    cells: args.cells,
  })
}

function CommandRow(props: {
  spec: CommandSpec
  cells: number
  labelCells: number
  selected: boolean
}): React.ReactNode {
  return (
    <box height={1} flexShrink={0}>
      <text>
        <Spans
          spans={rowSpans({
            spec: props.spec,
            cells: props.cells,
            labelCells: props.labelCells,
            selected: props.selected,
          })}
        />
      </text>
    </box>
  )
}

export function CommandMenu(props: { state: CommandMenuState; width: number }): React.ReactNode {
  const cells = Math.max(0, props.width - CHROME_COLUMNS)
  const { start, visible } = commandMenuWindow({ state: props.state, rows: COMMAND_MENU_ROWS })
  const labelCells = labelColumn(visible)
  const counted = `${props.state.index + 1}/${props.state.matches.length}`

  return (
    <Panel
      width={props.width}
      fill={theme.overlayBg}
      label={<text fg={theme.meta} bg={theme.overlayBg}>{' Commands '}</text>}
      badge={<text fg={theme.hint} bg={theme.overlayBg}>{` ${counted} · ⇥ complete `}</text>}
    >
      <box flexDirection="column" flexShrink={0}>
        {visible.map((spec, offset) => (
          <CommandRow
            key={qualifiedName(spec)}
            spec={spec}
            cells={cells}
            labelCells={labelCells}
            selected={start + offset === props.state.index}
          />
        ))}
      </box>
    </Panel>
  )
}
