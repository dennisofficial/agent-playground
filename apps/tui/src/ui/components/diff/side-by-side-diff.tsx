import type { DiffFile, DiffHunk, DiffLine, DiffRow } from '@dltech/atlas-core'
import type { TextChunk } from '@opentui/core'
import React, { useMemo, useState } from 'react'

import { rowDigits, sideBySideColumns, type SideBySideColumns } from '../../diff-layout'
import { theme } from '../../theme'
import { Panel } from '../panel'
import { useDiffChunks, type DiffEmphasis } from './diff-chunks'
import {
  DiffFooter,
  separatedSpans,
  SIDE_BY_SIDE_KEYS,
  SIDE_BY_SIDE_NOTE,
} from './diff-footer'
import { FileHeader, HunkHeading } from './diff-header'
import { patchText } from './diff-patch'
import { DIFF_CHROME } from './inline-diff'
import { SideBySideDiffRow } from './diff-row'
import { filetypeOf } from './diff-style'

function SideBySideHunk(props: {
  hunk: DiffHunk
  rows: readonly DiffRow[]
  columns: SideBySideColumns
  width: number
  filetype: string
  emphasis: DiffEmphasis | null
}): React.ReactNode {
  const chunks = useDiffChunks({ lines: props.hunk.lines, filetype: props.filetype })

  const byLine = useMemo(() => {
    const map = new Map<DiffLine, readonly TextChunk[] | null>()
    props.hunk.lines.forEach((line, index) => map.set(line, chunks[index] ?? null))
    return map
  }, [props.hunk.lines, chunks])

  const chunksOf = (line: DiffLine | null): readonly TextChunk[] | null =>
    line === null ? null : byLine.get(line) ?? null

  const emphasisOf = (line: DiffLine | null): ReturnType<DiffEmphasis> =>
    line === null || props.emphasis === null ? null : props.emphasis(line)

  return (
    <box flexDirection="column" flexShrink={0}>
      <HunkHeading hunk={props.hunk} width={props.width} />
      {props.rows.map((row, index) => (
        <SideBySideDiffRow
          key={index}
          row={row}
          chunks={{ left: chunksOf(row.left), right: chunksOf(row.right) }}
          columns={props.columns}
          emphasis={{ left: emphasisOf(row.left), right: emphasisOf(row.right) }}
        />
      ))}
    </box>
  )
}

/**
 * `rows[n]` are the paired rows of `file.hunks[n]`, as `sideBySideRows` returns them — the caller
 * pairs, this renders.
 */
export function SideBySideDiff(props: {
  file: DiffFile
  rows: readonly (readonly DiffRow[])[]
  width: number
  emphasis?: DiffEmphasis
}): React.ReactNode {
  const [pointerInside, setPointerInside] = useState(false)

  const content = Math.max(1, props.width - DIFF_CHROME)
  const columns = useMemo(
    () =>
      sideBySideColumns({
        width: content,
        digits: rowDigits({ rows: props.rows.flat() }),
      }),
    [content, props.rows],
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
          <SideBySideHunk
            key={index}
            hunk={hunk}
            rows={props.rows[index] ?? []}
            columns={columns}
            width={content}
            filetype={filetype}
            emphasis={props.emphasis ?? null}
          />
        ))}
      </Panel>
      <DiffFooter
        width={props.width}
        left={separatedSpans({ text: SIDE_BY_SIDE_NOTE, fg: theme.meta })}
        keys={SIDE_BY_SIDE_KEYS}
      />
    </box>
  )
}
