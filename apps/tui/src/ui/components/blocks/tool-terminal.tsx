/**
 * A shell command, drawn the way a terminal draws it.
 *
 * The rule is legacy atlas web's and it holds: colour the COMMAND and leave the output plain,
 * because output is not source in any language and a grammar applied to it invents structure that
 * is not there. So the command gets the bash grammar behind a green `$`, and what the command
 * printed is dim text beneath it — which is also what a real terminal looks like.
 *
 * While the call is still arriving the command types into the panel, since it rides on the call's
 * arguments; the output joins when the command has run.
 */

import React, { useMemo } from 'react'

import type { ToolCall } from '../../../store'
import { detailOf, inputOf, str } from '../../../store/tools'
import { stripAnsi } from '../../ansi'
import { tailOfPath } from '../../paths'
import { theme } from '../../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from '../panel'
import { MoreToggle, NOT_EXPANDABLE, shownOf, type Expander } from './more-toggle'
import { chunkSpans, useHighlighted, useRowChunks } from './tool-code-lines'

const CHROME = PANEL_INSET + PANEL_PAD

const MAX_ROWS = 12

const PROMPT = '$ '

/**
 * A bare <text> measures itself against what its parent still has and yoga caps it there, where the
 * row <box> this replaced let the content text keep its natural width and overflow the padding.
 * The explicit width reproduces that row: the prompt plus the content's own cells. Tabs are the two
 * cells the text buffer draws; every non-ASCII code point is counted as a possible wide cell — an
 * overestimate only pads with transparent blanks, an underestimate would clip a glyph.
 */
const cellWidth = (line: string): number => {
  let cells = 0
  for (const char of line) {
    cells += char === '\t' || (char.codePointAt(0) ?? 0) > 0x7f ? 2 : 1
  }
  return cells
}

function CommandRows(props: { command: string; columns: number }): React.ReactNode {
  const lines = useMemo(() => props.command.replace(/\n$/, '').split('\n'), [props.command])
  const chunks = useHighlighted({ lines, filetype: 'bash' })
  const rows = useRowChunks({ texts: lines, chunks, columns: props.columns })

  return (
    <>
      {rows.map((row, index) => {
        const content = row.reduce((joined, chunk) => joined + chunk.text, '')
        return (
          <text
            key={index}
            wrapMode="none"
            width={PROMPT.length + cellWidth(content)}
            flexShrink={0}
            fg={theme.body}
          >
            <span fg={theme.ok}>{index === 0 ? PROMPT : ' '.repeat(PROMPT.length)}</span>
            {chunkSpans(row)}
          </text>
        )
      })}
    </>
  )
}

export function ToolTerminal(props: {
  call: ToolCall
  inner: number
  expand?: Expander
}): React.ReactNode {
  const expand = props.expand ?? NOT_EXPANDABLE
  const command = str(inputOf(props.call).command)
  const printed = detailOf(props.call).map(stripAnsi)
  /**
   * A running command's output arrives live and is read from its TAIL — the panel is a terminal,
   * and a terminal shows where the output is now, not where it started. Once the call settles the
   * durable output takes over, read from its head with the rest behind the count as usual.
   */
  const live = (props.call.liveOutput ?? '').replace(/\n+$/, '').split('\n').map(stripAnsi)
  const running = printed.length === 0 && (props.call.liveOutput?.length ?? 0) > 0
  const shown = running ? live.slice(-MAX_ROWS) : shownOf({ body: printed, cap: MAX_ROWS, expand })
  const width = Math.max(24, props.inner - PANEL_PAD)
  const columns = Math.max(8, width - CHROME - PROMPT.length)

  return (
    <box marginLeft={PANEL_PAD} marginTop={1}>
      <Panel rail={theme.rule} fill={theme.panelBg} width={width}>
        {command === undefined ? null : <CommandRows command={command} columns={columns} />}
        {command === undefined || shown.length === 0 ? null : <text> </text>}
        {shown.map((line, index) => (
          <text key={index} wrapMode="none" flexShrink={0}>
            <span fg={theme.hint}>
              {tailOfPath({ path: line, cells: Math.max(8, width - CHROME) })}
            </span>
          </text>
        ))}
        {running ? null : (
          <MoreToggle hidden={printed.length - MAX_ROWS} indent="" expand={expand} />
        )}
      </Panel>
    </box>
  )
}
