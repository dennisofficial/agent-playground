/**
 * A file that was created, shown in the same panel an edit's diff gets.
 *
 * A `write` reports `path`, `created` and `bytes` and no patch, so there is nothing for the diff
 * renderer to take. The content is on the CALL rather than the result — the model sent it — so it can
 * be drawn without the tool changing. An `edit` still being dictated lands here too: its replacement
 * text types into this panel, and the real diff takes over when the call settles.
 *
 * Same chrome, no diff language: every line of a new file is new, so tinting them green and signing
 * them `+` states the obvious in colour a reader has been taught means "this line, in particular,
 * changed". Line numbers and the filetype's own highlighting are the whole of it.
 */

import React from 'react'

import type { ToolCall } from '../../../store'
import { dictatedContentOf, inputOf, relativise, str } from '../../../store/tools'
import { theme } from '../../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from '../panel'
import { MoreToggle, NOT_EXPANDABLE, shownOf, type Expander } from './more-toggle'
import { CodeLines, codeLinesOf } from './tool-code-lines'

const CHROME = PANEL_INSET + PANEL_PAD

const MAX_ROWS = 20

const plural = (many: number): string => `${many.toLocaleString('en-US')} ${many === 1 ? 'line' : 'lines'}`

function Header(props: { path: string; lines: number }): React.ReactNode {
  return (
    <>
      <text fg={theme.hover} wrapMode="none" flexShrink={1}>
        {props.path}
      </text>
      <box flexGrow={1} flexShrink={1} />
      <text fg={theme.rule} wrapMode="none" flexShrink={0}>
        {plural(props.lines)}
      </text>
    </>
  )
}

export function ToolCreatedFile(props: {
  call: ToolCall
  inner: number
  cwd: string
  expand?: Expander
}): React.ReactNode {
  const content = dictatedContentOf(props.call)
  if (content === undefined) return null

  const expand = props.expand ?? NOT_EXPANDABLE
  const path = relativise(str(inputOf(props.call).path) ?? props.call.name, props.cwd)
  const body = content.replace(/\n$/, '').split('\n')
  const shown = shownOf({ body, cap: MAX_ROWS, expand })
  const width = Math.max(24, props.inner - PANEL_PAD)

  return (
    <box marginLeft={PANEL_PAD} marginTop={1}>
      <Panel
        rail={theme.rule}
        fill={theme.panelBg}
        band={theme.diff.bandBg}
        width={width}
        header={<Header path={path} lines={body.length} />}
      >
        <CodeLines
          lines={codeLinesOf(shown.map((line, index) => `${index + 1}\t${line}`))}
          path={path}
          inner={Math.max(1, width - CHROME)}
          indent=""
        />
        <MoreToggle hidden={body.length - MAX_ROWS} indent="" expand={expand} />
      </Panel>
    </box>
  )
}
