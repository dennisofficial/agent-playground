import type { DiffFile, DiffHunk } from '@dltech/atlas-core'
import React, { useMemo, useState } from 'react'

import { inlineColumns, numberDigits, type InlineColumns } from '../../diff-layout'
import { theme } from '../../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from '../panel'
import { useDiffChunks, type DiffEmphasis } from './diff-chunks'
import { DiffFooter, filesSpans, INLINE_KEYS, type DiffFileCount } from './diff-footer'
import { FileHeader, HunkHeading } from './diff-header'
import { patchText } from './diff-patch'
import { InlineDiffRow } from './diff-row'
import { filetypeOf } from './diff-style'

export const DIFF_CHROME = PANEL_INSET + PANEL_PAD

function InlineHunk(props: {
  hunk: DiffHunk
  columns: InlineColumns
  width: number
  filetype: string
  emphasis: DiffEmphasis | null
}): React.ReactNode {
  const chunks = useDiffChunks({ lines: props.hunk.lines, filetype: props.filetype })

  return (
    <box flexDirection="column" flexShrink={0}>
      <HunkHeading hunk={props.hunk} width={props.width} />
      {props.hunk.lines.map((line, index) => (
        <InlineDiffRow
          key={index}
          line={line}
          chunks={chunks[index] ?? null}
          columns={props.columns}
          emphasis={props.emphasis === null ? null : props.emphasis(line)}
        />
      ))}
    </box>
  )
}

export function InlineDiff(props: {
  file: DiffFile
  width: number
  files?: DiffFileCount | null
  emphasis?: DiffEmphasis
}): React.ReactNode {
  const [pointerInside, setPointerInside] = useState(false)

  const content = Math.max(1, props.width - DIFF_CHROME)
  const columns = useMemo(
    () =>
      inlineColumns({
        width: content,
        digits: numberDigits({ lines: props.file.hunks.flatMap((hunk) => hunk.lines) }),
      }),
    [content, props.file],
  )
  const patch = useMemo(() => patchText({ file: props.file }), [props.file])
  const filetype = useMemo(() => filetypeOf({ path: props.file.path }), [props.file.path])

  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      onMouseOver={() => setPointerInside(true)}
      onMouseOut={() => setPointerInside(false)}
    >
      <Panel
        rail={theme.rule}
        fill={theme.panelBg}
        band={theme.diff.bandBg}
        width={props.width}
        header={<FileHeader file={props.file} patch={patch} revealed={pointerInside} />}
      >
        {props.file.hunks.map((hunk, index) => (
          <InlineHunk
            key={index}
            hunk={hunk}
            columns={columns}
            width={content}
            filetype={filetype}
            emphasis={props.emphasis ?? null}
          />
        ))}
      </Panel>
      <DiffFooter
        width={props.width}
        left={filesSpans({ files: props.files ?? null })}
        keys={INLINE_KEYS}
      />
    </box>
  )
}
