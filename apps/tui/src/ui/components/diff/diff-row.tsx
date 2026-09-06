import { EDiffLine, type DiffLine, type DiffRow } from '@dltech/atlas-core'
import { RGBA, StyledText, type TextChunk } from '@opentui/core'
import React, { useMemo } from 'react'

import { fitDiffChunks } from '../../markdown/highlight-rows'
import {
  inlineWidth,
  sideBySideWidth,
  type InlineColumns,
  type SideBySideColumns,
  type SideColumns,
} from '../../diff-layout'
import { theme } from '../../theme'
import {
  cachedColour,
  chunksFor,
  dimChunks,
  emphasiseChunks,
  emphasisBg,
  type DiffSpan,
} from './chunk-styling'
import {
  diffTone,
  DIVIDER_GLYPH,
  inlineNumber,
  lineText,
  numberText,
  type DiffTone,
} from './diff-style'

/**
 * OpenTUI fills a painted background with the buffer's default foreground (white); a filler span
 * has to say it out loud or the captured cells shift colour.
 */
const FILL_FG = RGBA.fromInts(255, 255, 255, 255)

function gutterChunk(args: {
  line: DiffLine | null
  number: number | null
  columns: number
  gap: number
  gapFirst: boolean
}): TextChunk | null {
  if (args.columns + args.gap <= 0) return null
  const digits = numberText({ line: args.line, number: args.number, columns: args.columns })
  const padding = ' '.repeat(Math.max(0, args.gap))
  return {
    __isChunk: true,
    text: args.gapFirst ? `${padding}${digits}` : `${digits}${padding}`,
    fg: cachedColour(theme.diff.gutterFg),
  }
}

function signChunk(args: { tone: DiffTone; columns: number; gap: number }): TextChunk | null {
  if (args.columns + args.gap <= 0) return null
  return {
    __isChunk: true,
    text: `${args.tone.sign.slice(0, args.columns)}${' '.repeat(Math.max(0, args.gap))}`,
    fg: cachedColour(args.tone.signFg),
  }
}

function codeChunks(args: {
  text: string
  chunks: readonly TextChunk[] | null
  columns: number
  tone: DiffTone
  emphasis: DiffSpan | null
}): TextChunk[] {
  if (args.columns <= 0) return []
  const base = chunksFor({ text: args.text, chunks: args.chunks })
  const toned = args.tone.dim ? dimChunks(base) : base
  const marked =
    args.emphasis === null
      ? toned
      : emphasiseChunks({ chunks: toned, span: args.emphasis, bg: emphasisBg(theme.diff.wordBg) })
  return [...fitDiffChunks({ chunks: marked, columns: args.columns })]
}

const fillerChunk = (cells: number): TextChunk | null =>
  cells <= 0 ? null : { __isChunk: true, text: ' '.repeat(cells), fg: FILL_FG }

const keep = (chunks: readonly (TextChunk | null)[]): TextChunk[] =>
  chunks.filter((chunk): chunk is TextChunk => chunk !== null)

/**
 * The tint stays a real box behind the text rather than a padding span inside it: spaces in the
 * buffer would land in `getSelectedText`, while a box fill is painted but never selected.
 */
function RowText(props: {
  content: StyledText
  width: number
  tone: DiffTone
  painted: string | undefined
}): React.ReactNode {
  const text = (
    <text
      content={props.content}
      wrapMode="none"
      width={props.width}
      height={1}
      flexShrink={0}
      fg={props.tone.contentFg ?? theme.body}
      {...(props.painted === undefined ? {} : { bg: props.painted })}
    />
  )
  if (props.painted === undefined) return text
  return (
    <box width={props.width} height={1} flexShrink={0} backgroundColor={props.painted}>
      {text}
    </box>
  )
}

export function InlineDiffRow(props: {
  line: DiffLine
  chunks: readonly TextChunk[] | null
  columns: InlineColumns
  emphasis: DiffSpan | null
}): React.ReactNode {
  const tone = diffTone({ kind: props.line.kind })

  const content = useMemo(() => {
    const spans: TextChunk[] = []
    const gutter = gutterChunk({
      line: props.line,
      number: inlineNumber(props.line),
      columns: props.columns.numbers,
      gap: props.columns.numberGap,
      gapFirst: false,
    })
    if (gutter !== null) spans.push(gutter)
    const sign = signChunk({ tone, columns: props.columns.sign, gap: props.columns.signGap })
    if (sign !== null) spans.push(sign)
    spans.push(
      ...codeChunks({
        text: lineText(props.line),
        chunks: props.line.kind === EDiffLine.Elision ? null : props.chunks,
        columns: props.columns.code,
        tone,
        emphasis: props.emphasis,
      }),
    )
    return new StyledText(spans)
  }, [props.line, props.chunks, props.columns, props.emphasis, tone])

  return (
    <RowText
      content={content}
      width={inlineWidth(props.columns)}
      tone={tone}
      painted={tone.tint}
    />
  )
}

/**
 * A half's gutter is pinned to the split by element position in the old layout; in one text the
 * same position comes from a filler span between code and gutter. That filler is selectable text
 * where the old layout painted unselectable background — the cost of one renderable per half.
 */
function Half(props: {
  line: DiffLine | null
  number: number | null
  chunks: readonly TextChunk[] | null
  columns: SideColumns
  emphasis: DiffSpan | null
  gutterFirst: boolean
}): React.ReactNode {
  const tone = diffTone({ kind: props.line?.kind ?? EDiffLine.Context })
  const painted = props.line === null ? undefined : tone.tint

  const content = useMemo(() => {
    const code = codeChunks({
      text: props.line === null ? '' : lineText(props.line),
      chunks: props.line === null || props.line.kind === EDiffLine.Elision ? null : props.chunks,
      columns: props.columns.code,
      tone,
      emphasis: props.emphasis,
    })
    const filler = fillerChunk(
      props.columns.code - code.reduce((total, chunk) => total + chunk.text.length, 0),
    )
    const gutter = gutterChunk({
      line: props.line,
      number: props.number,
      columns: props.columns.numbers,
      gap: props.columns.numberGap,
      gapFirst: !props.gutterFirst,
    })
    const spans = props.gutterFirst ? [gutter, ...code, filler] : [...code, filler, gutter]
    return new StyledText(keep(spans))
  }, [props.line, props.number, props.chunks, props.columns, props.emphasis, props.gutterFirst, tone])

  return (
    <text
      content={content}
      wrapMode="none"
      width={props.columns.code + props.columns.numberGap + props.columns.numbers}
      height={1}
      flexShrink={0}
      fg={tone.contentFg ?? theme.body}
      {...(painted === undefined ? {} : { bg: painted })}
    />
  )
}

export function SideBySideDiffRow(props: {
  row: DiffRow
  chunks: { left: readonly TextChunk[] | null; right: readonly TextChunk[] | null }
  columns: SideBySideColumns
  emphasis: { left: DiffSpan | null; right: DiffSpan | null }
}): React.ReactNode {
  return (
    <box
      flexDirection="row"
      width={sideBySideWidth(props.columns)}
      height={1}
      flexShrink={0}
    >
      <Half
        line={props.row.left}
        number={props.row.left?.oldNumber ?? null}
        chunks={props.chunks.left}
        columns={props.columns.left}
        emphasis={props.emphasis.left}
        gutterFirst={false}
      />
      {props.columns.divider > 0 ? (
        <text wrapMode="none" width={props.columns.divider} flexShrink={0} fg={theme.rule}>
          {DIVIDER_GLYPH.repeat(props.columns.divider)}
        </text>
      ) : null}
      <Half
        line={props.row.right}
        number={props.row.right?.newNumber ?? null}
        chunks={props.chunks.right}
        columns={props.columns.right}
        emphasis={props.emphasis.right}
        gutterFirst
      />
    </box>
  )
}
