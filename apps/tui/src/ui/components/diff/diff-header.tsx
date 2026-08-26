import type { DiffFile, DiffHunk } from '@dltech/atlas-core'
import React from 'react'

import { hunkMarker } from '../../diff-layout'
import { cellsOf } from '../../hint-layout'
import { CopyButton } from '../../markdown/copy-button'
import { theme } from '../../theme'
import { Spans, type Span } from '../spans'
import { MINUS_SIGN } from './diff-style'

export function clipSpans(args: { spans: readonly Span[]; columns: number }): Span[] {
  const out: Span[] = []
  let used = 0
  for (const span of args.spans) {
    if (used >= args.columns) break
    const text = [...span.text].slice(0, args.columns - used).join('')
    out.push({ ...span, text })
    used += cellsOf(text)
  }
  return out
}

export function FileHeader(props: {
  file: DiffFile
  patch: string
  revealed: boolean
}): React.ReactNode {
  return (
    <>
      <text fg={theme.hover} wrapMode="none" flexShrink={1}>
        {props.file.path}
      </text>
      <box flexGrow={1} flexShrink={1} />
      <text wrapMode="none" flexShrink={0}>
        <span fg={theme.ok}>{`+${props.file.added}`}</span>
        <span>{' '}</span>
        <span fg={theme.error}>{`${MINUS_SIGN}${props.file.removed}`}</span>
        <span fg={theme.rule}>{props.revealed ? ' · ' : ''}</span>
      </text>
      <CopyButton text={props.patch} revealed={props.revealed} />
    </>
  )
}

export function HunkHeading(props: { hunk: DiffHunk; width: number }): React.ReactNode {
  const marker = hunkMarker({ hunk: props.hunk })
  const spans: Span[] = [
    { text: marker, fg: theme.meta },
    ...(props.hunk.heading.length === 0
      ? []
      : [{ text: ' ' }, { text: props.hunk.heading, fg: theme.code }]),
  ]

  return (
    <box
      flexDirection="row"
      width={props.width}
      height={1}
      flexShrink={0}
      backgroundColor={theme.diff.bandBg}
    >
      <text wrapMode="none" width={props.width} flexShrink={0} bg={theme.diff.bandBg}>
        <Spans spans={clipSpans({ spans, columns: props.width })} />
      </text>
    </box>
  )
}
