import { capHunks, type DiffFile, type DiffHunk } from '@dltech/atlas-core'
import React, { useMemo, useState } from 'react'

import { inlineColumns, numberDigits, type InlineColumns } from '../../diff-layout'
import { theme } from '../../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from '../panel'
import { useDiffChunks, type DiffEmphasis } from './diff-chunks'
import { DiffFooter, filesSpans, type DiffFileCount } from './diff-footer'
import { FileHeader } from './diff-header'
import { patchText } from './diff-patch'
import { InlineDiffRow } from './diff-row'
import { filetypeOf } from './diff-style'

export const DIFF_CHROME = PANEL_INSET + PANEL_PAD

/**
 * Each rendered diff line spends a native TextBuffer out of a pool of 2^14 shared by the whole
 * tile, and a whole-file rewrite (a regenerated bundle, a reformatted snapshot) is thousands of
 * lines — enough to exhaust the pool mid-render and blank the tile. Past the cap the tail of the
 * diff stands in as one overflow row; the header counts and the clipboard patch stay full.
 */
export const DIFF_ROW_CAP = 200

function InlineHunk(props: {
  hunk: DiffHunk
  columns: InlineColumns
  filetype: string
  emphasis: DiffEmphasis | null
}): React.ReactNode {
  const chunks = useDiffChunks({ lines: props.hunk.lines, filetype: props.filetype })

  return (
    <box flexDirection="column" flexShrink={0}>
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
  /** What the copy button puts on the clipboard, when the file's own hunks are not the patch. */
  patch?: string
}): React.ReactNode {
  const [pointerInside, setPointerInside] = useState(false)

  const file = useMemo(
    () => ({ ...props.file, hunks: capHunks({ hunks: props.file.hunks, cap: DIFF_ROW_CAP }) }),
    [props.file],
  )
  const content = Math.max(1, props.width - DIFF_CHROME)
  const columns = useMemo(
    () =>
      inlineColumns({
        width: content,
        digits: numberDigits({ lines: file.hunks.flatMap((hunk) => hunk.lines) }),
      }),
    [content, file],
  )
  const patch = useMemo(
    () => props.patch ?? patchText({ file: props.file }),
    [props.file, props.patch],
  )
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
        {file.hunks.map((hunk, index) => (
          <InlineHunk
            key={index}
            hunk={hunk}
            columns={columns}
            filetype={filetype}
            emphasis={props.emphasis ?? null}
          />
        ))}
      </Panel>
      <DiffFooter
        width={props.width}
        left={filesSpans({ files: props.files ?? null })}
      />
    </box>
  )
}
