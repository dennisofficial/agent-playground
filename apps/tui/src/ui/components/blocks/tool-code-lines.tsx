/**
 * An opened `read` shows the file the way the file looks.
 *
 * The diff gets tree-sitter through `useDiffChunks`; a read would otherwise fall through to the same
 * dim stdout renderer as `ls`. Same machinery, one side instead of two: the read tool hands back
 * numbered rows, so the number goes to a gutter and the content goes to the highlighter under the
 * filetype of the path that was read.
 */

import { pathToFiletype, StyledText, type TextChunk } from '@opentui/core'
import React, { useEffect, useMemo, useState } from 'react'

import { cachedHighlight, fitDiffChunks, highlightRows } from '../../markdown/highlight-rows'
import { theme } from '../../theme'
import { chunksFor } from '../diff/chunk-styling'

export type CodeLine = { number: number | null; text: string }

const NUMBERED = /^(\d+)\t(.*)$/

/** The read tool's own shape: a line number, a tab, the line. Anything else is content with no number. */
export function codeLinesOf(body: readonly string[]): CodeLine[] {
  return body.map((line) => {
    const match = NUMBERED.exec(line)
    if (match === null) return { number: null, text: line }
    return { number: Number.parseInt(match[1] ?? '', 10), text: match[2] ?? '' }
  })
}

type Rows = readonly (readonly TextChunk[])[] | null

export function useHighlighted(args: {
  lines: readonly string[]
  filetype: string
}): readonly (readonly TextChunk[] | null)[] {
  const { lines, filetype } = args
  const key = useMemo(() => `${filetype} ${lines.join('\n')}`, [lines, filetype])
  const cached = useMemo(() => cachedHighlight({ lines, filetype }) ?? null, [lines, filetype])
  const [settled, setSettled] = useState<{ key: string; rows: Rows } | null>(null)

  useEffect(() => {
    let live = true
    void highlightRows({ lines, filetype }).then((rows) => {
      if (live) setSettled({ key, rows })
    })
    return () => {
      live = false
    }
  }, [key, lines, filetype])

  const rows = settled?.key === key ? settled.rows : cached
  return lines.map((_unused, index) => rows?.[index] ?? null)
}

export function CodeLines(props: {
  lines: readonly CodeLine[]
  path: string
  inner: number
  indent: string
}): React.ReactNode {
  const filetype = useMemo(() => pathToFiletype(props.path) ?? 'text', [props.path])
  const texts = useMemo(() => props.lines.map((line) => line.text), [props.lines])
  const chunks = useHighlighted({ lines: texts, filetype })
  const digits = Math.max(
    2,
    ...props.lines.map((line) => (line.number === null ? 0 : String(line.number).length)),
  )
  const columns = Math.max(1, props.inner - props.indent.length - digits - 1)

  return (
    <>
      {props.lines.map((line, index) => (
        <box key={index} flexDirection="row" height={1} flexShrink={0}>
          <text wrapMode="none" flexShrink={0} fg={theme.rule}>
            {`${props.indent}${(line.number === null ? '' : String(line.number)).padStart(digits)} `}
          </text>
          <text
            wrapMode="none"
            width={columns}
            flexShrink={0}
            fg={theme.body}
            content={
              new StyledText([
                ...fitDiffChunks({
                  chunks: chunksFor({ text: line.text, chunks: chunks[index] ?? null }),
                  columns,
                }),
              ])
            }
          />
        </box>
      ))}
    </>
  )
}
