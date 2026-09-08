/**
 * The card a merged segment draws: one row for the file, one panel holding every pass at it.
 *
 * The label and glyph are the first read's — every read in the segment names the same file — while
 * the measure is the sum, because `+1 −1` twice is what it is.
 */

import React, { useMemo } from 'react'

import { diffStatOf, type Read } from '../../../store/tools'
import { useClickRegion } from '../../hooks/use-click-region'
import { tailOfPath } from '../../paths'
import { markPaint, type EMark } from '../../tool-marks'
import { MINUS_SIGN } from '../diff/diff-style'
import { MergedDiff } from '../diff/merged-diff'
import { Attachments } from './tool-run-attachments'
import { GAP } from './tool-run-rows'

const summedNote = (reads: readonly Read[]): string => {
  let added = 0
  let removed = 0
  for (const read of reads) {
    const stat = diffStatOf(read.call)
    added += stat?.added ?? 0
    removed += stat?.removed ?? 0
  }
  return `+${added} ${MINUS_SIGN}${removed}`
}

export const MergedBlock = React.memo(function MergedBlock(props: {
  reads: readonly Read[]
  inner: number
  cwd: string
  mark: EMark
  opensCluster: boolean
  opened: ReadonlySet<string>
  onToggle: (key: string) => void
}): React.ReactNode {
  const first = props.reads[0]
  const region = useClickRegion(() => {
    if (first !== undefined) props.onToggle(first.call.callId)
  })
  const note = useMemo(() => summedNote(props.reads), [props.reads])
  if (first === undefined) return null

  const paint = markPaint({
    style: props.mark,
    klass: first.reading.klass,
    ok: !first.reading.failed,
    opensCluster: props.opensCluster,
  })
  const room = Math.max(8, props.inner - 2 - note.length - GAP)
  const label = tailOfPath({ path: first.reading.alone ?? first.reading.line, cells: room })
  const pad = ' '.repeat(Math.max(0, room - [...label].length))

  return (
    <box flexDirection="column" marginBottom={1} width={props.inner} flexShrink={0}>
      <text wrapMode="none" width={props.inner} flexShrink={0} {...region.handlers}>
        <span fg={paint.fg} {...region.wash}>
          {paint.glyph}
        </span>
        <span fg={paint.text} {...region.wash}>{`${label}${pad}`}</span>
        <span fg={paint.note} {...region.wash}>{`${' '.repeat(GAP)}${note}`}</span>
      </text>
      <Attachments
        calls={props.reads.map((read) => read.call)}
        inner={props.inner}
        cwd={props.cwd}
        opened={props.opened}
        onToggle={props.onToggle}
      />
      <MergedDiff
        calls={props.reads.map((read) => read.call)}
        inner={props.inner}
        cwd={props.cwd}
      />
    </box>
  )
})
