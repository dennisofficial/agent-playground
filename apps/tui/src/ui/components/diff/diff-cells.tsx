import type { DiffLine } from '@dltech/atlas-core'
import { StyledText, type TextChunk } from '@opentui/core'
import React, { useMemo } from 'react'

import { fitDiffChunks } from '../../markdown/highlight-rows'
import { theme } from '../../theme'
import {
  chunksFor,
  dimChunks,
  emphasiseChunks,
  emphasisBg,
  type DiffSpan,
} from './chunk-styling'
import { numberText, type DiffTone } from './diff-style'

export function CodeCell(props: {
  text: string
  chunks: readonly TextChunk[] | null
  columns: number
  tone: DiffTone
  emphasis: DiffSpan | null
}): React.ReactNode {
  const { text, chunks, columns, tone, emphasis } = props

  const content = useMemo(() => {
    const base = chunksFor({ text, chunks })
    const toned = tone.dim ? dimChunks(base) : base
    const marked =
      emphasis === null
        ? toned
        : emphasiseChunks({ chunks: toned, span: emphasis, bg: emphasisBg(theme.diff.wordBg) })
    return new StyledText([...fitDiffChunks({ chunks: marked, columns })])
  }, [text, chunks, columns, tone.dim, emphasis])

  if (columns <= 0) return null

  return (
    <text
      content={content}
      wrapMode="none"
      width={columns}
      flexShrink={0}
      fg={tone.contentFg ?? theme.body}
      {...(tone.tint === undefined ? {} : { bg: tone.tint })}
    />
  )
}

export function GutterCell(props: {
  line: DiffLine | null
  number: number | null
  columns: number
  gap: number
  gapFirst: boolean
  tone: DiffTone
}): React.ReactNode {
  const width = props.columns + props.gap
  if (width <= 0) return null

  const digits = numberText({ line: props.line, number: props.number, columns: props.columns })
  const padding = ' '.repeat(Math.max(0, props.gap))

  return (
    <text
      wrapMode="none"
      width={width}
      flexShrink={0}
      fg={theme.diff.gutterFg}
      {...(props.tone.tint === undefined ? {} : { bg: props.tone.tint })}
    >
      {props.gapFirst ? `${padding}${digits}` : `${digits}${padding}`}
    </text>
  )
}

export function SignCell(props: {
  tone: DiffTone
  columns: number
  gap: number
}): React.ReactNode {
  const width = props.columns + props.gap
  if (width <= 0) return null

  return (
    <text
      wrapMode="none"
      width={width}
      flexShrink={0}
      fg={props.tone.signFg}
      {...(props.tone.tint === undefined ? {} : { bg: props.tone.tint })}
    >
      {`${props.tone.sign.slice(0, props.columns)}${' '.repeat(Math.max(0, props.gap))}`}
    </text>
  )
}
