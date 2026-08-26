import { EDiffLine, type DiffLine, type DiffRow } from '@dltech/atlas-core'
import type { TextChunk } from '@opentui/core'
import React from 'react'

import {
  inlineWidth,
  sideBySideWidth,
  type InlineColumns,
  type SideBySideColumns,
  type SideColumns,
} from '../../diff-layout'
import { theme } from '../../theme'
import type { DiffSpan } from './chunk-styling'
import { CodeCell, GutterCell, SignCell } from './diff-cells'
import { diffTone, DIVIDER_GLYPH, inlineNumber, lineText } from './diff-style'

export function InlineDiffRow(props: {
  line: DiffLine
  chunks: readonly TextChunk[] | null
  columns: InlineColumns
  emphasis: DiffSpan | null
}): React.ReactNode {
  const tone = diffTone({ kind: props.line.kind })

  return (
    <box
      flexDirection="row"
      width={inlineWidth(props.columns)}
      height={1}
      flexShrink={0}
      {...(tone.tint === undefined ? {} : { backgroundColor: tone.tint })}
    >
      <GutterCell
        line={props.line}
        number={inlineNumber(props.line)}
        columns={props.columns.numbers}
        gap={props.columns.numberGap}
        gapFirst={false}
        tone={tone}
      />
      <SignCell tone={tone} columns={props.columns.sign} gap={props.columns.signGap} />
      <CodeCell
        text={lineText(props.line)}
        chunks={props.line.kind === EDiffLine.Elision ? null : props.chunks}
        columns={props.columns.code}
        tone={tone}
        emphasis={props.emphasis}
      />
    </box>
  )
}

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

  const gutter = (
    <GutterCell
      line={props.line}
      number={props.number}
      columns={props.columns.numbers}
      gap={props.columns.numberGap}
      gapFirst={!props.gutterFirst}
      tone={tone}
    />
  )
  const code = (
    <CodeCell
      text={props.line === null ? '' : lineText(props.line)}
      chunks={props.line === null || props.line.kind === EDiffLine.Elision ? null : props.chunks}
      columns={props.columns.code}
      tone={tone}
      emphasis={props.emphasis}
    />
  )

  return (
    <box
      flexDirection="row"
      width={props.columns.code + props.columns.numberGap + props.columns.numbers}
      height={1}
      flexShrink={0}
      {...(painted === undefined ? {} : { backgroundColor: painted })}
    >
      {props.gutterFirst ? gutter : code}
      {props.gutterFirst ? code : gutter}
    </box>
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
