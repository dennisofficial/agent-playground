import React from 'react'

import { cellsOf, fitHints, HINT_SEPARATOR, hintSpans, type Hint } from '../../hint-layout'
import { SIDE_BY_SIDE_MIN_TERMINAL_WIDTH, theme } from '../../theme'
import { Spans, type Span } from '../spans'
import { clipSpans } from './diff-header'

export type DiffKey = Hint & { colour: string }

export type DiffFileCount = { index: number; total: number }

export const SIDE_BY_SIDE_NOTE = `fits above ${SIDE_BY_SIDE_MIN_TERMINAL_WIDTH} cols${HINT_SEPARATOR}falls back to inline below it`

const spanCells = (spans: readonly Span[]): number =>
  spans.reduce((total, span) => total + cellsOf(span.text), 0)

export function keySpans(args: { keys: readonly DiffKey[]; cells: number }): Span[] {
  const kept = fitHints({ hints: args.keys, cells: args.cells })
  return args.keys
    .filter((key) => kept.some((hint) => hint.key === key.key && hint.label === key.label))
    .flatMap((key, index) => [
      ...(index === 0 ? [] : [{ text: HINT_SEPARATOR, fg: theme.rule }]),
      ...hintSpans({ hints: [{ key: key.key, label: key.label }], keyColour: key.colour }),
    ])
}

export function separatedSpans(args: { text: string; fg: string }): Span[] {
  return args.text
    .split(HINT_SEPARATOR)
    .flatMap((piece, index) => [
      ...(index === 0 ? [] : [{ text: HINT_SEPARATOR, fg: theme.rule }]),
      { text: piece, fg: args.fg },
    ])
}

export function filesSpans(args: { files: DiffFileCount | null }): Span[] {
  if (args.files === null) return []
  return [{ text: `${args.files.index}/${args.files.total} files`, fg: theme.meta }]
}

export function DiffFooter(props: {
  width: number
  left: readonly Span[]
  keys?: readonly DiffKey[]
}): React.ReactNode {
  const right = keySpans({ keys: props.keys ?? [], cells: props.width })
  const left = clipSpans({
    spans: props.left,
    columns: Math.max(0, props.width - spanCells(right)),
  })
  const pad = Math.max(0, props.width - spanCells(left) - spanCells(right))

  return (
    <box flexDirection="row" width={props.width} height={1} flexShrink={0}>
      <text wrapMode="none" width={props.width} flexShrink={0}>
        <Spans spans={left} />
        {pad > 0 ? <span>{' '.repeat(pad)}</span> : null}
        <Spans spans={right} />
      </text>
    </box>
  )
}
