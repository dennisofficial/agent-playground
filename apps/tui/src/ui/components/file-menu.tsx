import React from 'react'

import {
  FILE_MENU_ROWS,
  fileMenuWindow,
  pathOfEntry,
  selectedEntry,
  type FileMenuState,
} from '../file-menu-model'
import { cellsOf } from '../hint-layout'
import { shortenPath } from '../path-shorten'
import { glyph, theme } from '../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from './panel'
import { clipSpans } from './sidebar/cells'
import { Spans, type Span } from './spans'

const CHROME_COLUMNS = PANEL_INSET + PANEL_PAD

const CARET_CELLS = 2

function rowSpans(args: { path: string; cells: number; selected: boolean }): Span[] {
  const band = args.selected ? { bg: theme.hoverBg } : {}
  const { directory, name } = shortenPath({
    path: args.path,
    cells: Math.max(0, args.cells - CARET_CELLS),
  })
  const spent = CARET_CELLS + cellsOf(directory) + cellsOf(name)
  const fill = ' '.repeat(Math.max(0, args.cells - spent))

  return clipSpans({
    spans: [
      { text: args.selected ? `${glyph.selected} ` : '  ', fg: theme.accent, ...band },
      { text: directory, fg: theme.hint, ...band },
      { text: name, fg: args.selected ? theme.bright : theme.hover, ...band },
      { text: fill, ...band },
    ],
    cells: args.cells,
  })
}

function FileRow(props: { path: string; cells: number; selected: boolean }): React.ReactNode {
  return (
    <box height={1} flexShrink={0}>
      <text>
        <Spans spans={rowSpans({ path: props.path, cells: props.cells, selected: props.selected })} />
      </text>
    </box>
  )
}

export function FileMenu(props: { state: FileMenuState; width: number }): React.ReactNode {
  const cells = Math.max(0, props.width - CHROME_COLUMNS)
  const { start, visible } = fileMenuWindow({ state: props.state, rows: FILE_MENU_ROWS })
  const counted = `${props.state.index + 1}/${props.state.matches.length}`
  const verb = selectedEntry(props.state)?.isDirectory === true ? 'open' : 'attach'

  return (
    <Panel
      width={props.width}
      fill={theme.overlayBg}
      label={<text fg={theme.meta} bg={theme.overlayBg}>{' Files '}</text>}
      badge={<text fg={theme.hint} bg={theme.overlayBg}>{` ${counted} · ⇥ ${verb} `}</text>}
    >
      <box flexDirection="column" flexShrink={0}>
        {visible.map((entry, offset) => (
          <FileRow
            key={entry.name}
            path={pathOfEntry({ directory: props.state.directory, entry })}
            cells={cells}
            selected={start + offset === props.state.index}
          />
        ))}
      </box>
    </Panel>
  )
}
