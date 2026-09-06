/**
 * An opened `read` shows the file the way the file looks.
 *
 * The diff gets tree-sitter through `useDiffChunks`; a read would otherwise fall through to the same
 * dim stdout renderer as `ls`. Same machinery, one side instead of two: the read tool hands back
 * numbered rows, so the number goes to a gutter and the content goes to the highlighter under the
 * filetype of the path that was read.
 */

import { pathToFiletype, StyledText, type TextChunk } from '@opentui/core'
import React, { useEffect, useMemo, useRef, useState } from 'react'

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

type Settled = { key: string; rows: Rows }

const sameSettled = (current: Settled | null, next: Settled): Settled =>
  current !== null && current.key === next.key && current.rows === next.rows ? current : next

export type LineChunks = readonly (readonly TextChunk[] | null)[]

/**
 * Highlighting is asynchronous, so a row is drawn plain first and coloured when tree-sitter answers.
 * The effect is keyed on the CONTENT, never on the array carrying it: a caller that rebuilds its
 * lines every render must not restart the pass, and an answer that matches what is already held
 * must not schedule a render, or the block re-renders itself forever.
 */
export function useHighlighted(args: { lines: readonly string[]; filetype: string }): LineChunks {
  const { lines, filetype } = args
  const key = useMemo(() => `${filetype} ${lines.join('\n')}`, [lines, filetype])
  const cached = useMemo(() => cachedHighlight({ lines, filetype }), [lines, filetype])
  const [settled, setSettled] = useState<Settled | null>(null)
  const latest = useRef({ lines, filetype })
  latest.current = { lines, filetype }

  useEffect(() => {
    if (cachedHighlight(latest.current) !== undefined) return
    let live = true
    void highlightRows(latest.current).then((rows) => {
      if (live) setSettled((current) => sameSettled(current, { key, rows }))
    })
    return () => {
      live = false
    }
  }, [key])

  const rows = settled?.key === key ? settled.rows : (cached ?? null)
  return useMemo(() => lines.map((_unused, index) => rows?.[index] ?? null), [lines, rows])
}

export function useStyledRows(args: {
  texts: readonly string[]
  chunks: LineChunks
  columns: number
}): readonly StyledText[] {
  const { texts, chunks, columns } = args
  return useMemo(
    () =>
      texts.map(
        (text, index) =>
          new StyledText([
            ...fitDiffChunks({ chunks: chunksFor({ text, chunks: chunks[index] ?? null }), columns }),
          ]),
      ),
    [texts, chunks, columns],
  )
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
  const styled = useStyledRows({ texts, chunks, columns })

  return (
    <>
      {styled.map((content, index) => {
        const number = props.lines[index]?.number ?? null
        return (
          <box key={index} flexDirection="row" height={1} flexShrink={0}>
            <text wrapMode="none" flexShrink={0} fg={theme.rule}>
              {`${props.indent}${(number === null ? '' : String(number)).padStart(digits)} `}
            </text>
            <text wrapMode="none" width={columns} flexShrink={0} fg={theme.body} content={content} />
          </box>
        )
      })}
    </>
  )
}
