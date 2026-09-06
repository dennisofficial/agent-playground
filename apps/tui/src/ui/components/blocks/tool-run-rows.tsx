import React, { useMemo } from 'react'

import type { ToolCall } from '../../../store'
import type { EDetail, Read } from '../../../store/tools'
import { useClickRegion } from '../../hooks/use-click-region'
import { useHighWater } from '../../hooks/use-high-water'
import { tailOfPath } from '../../paths'
import { theme } from '../../theme'
import type { Expander } from './more-toggle'
import { ToolDetail } from './tool-detail'
import { moreKey } from './tool-run-expansion'

export const HANG = '  '

export const GAP = 2

export const STREAM_TAIL = 3

const LANE = 8

export const RunDetail = React.memo(function RunDetail(props: {
  detail: EDetail
  call: ToolCall
  inner: number
  cwd: string
  expanded: boolean
  onToggle: (key: string) => void
}): React.ReactNode {
  const { expanded, onToggle } = props
  const callId = props.call.callId
  const expand = useMemo(
    (): Expander => ({ expanded, onToggle: () => onToggle(moreKey(callId)) }),
    [expanded, onToggle, callId],
  )

  return (
    <ToolDetail
      detail={props.detail}
      call={props.call}
      inner={props.inner}
      cwd={props.cwd}
      expand={expand}
    />
  )
})

/**
 * A row of the list under a sentence.
 *
 * The label takes the BRIGHT colour and the lane and measure either side of it stay at the rule. The
 * list exists to be read down, so the thing being read has to be the thing that is lit; a list where
 * every column is equally dim is a list the eye slides off.
 */
export function Row(props: {
  read: Read
  inner: number
  cwd: string
  /** A list of one has nothing to choose between — opening the group IS opening the call. */
  only: boolean
  opened: ReadonlySet<string>
  onToggle: (key: string) => void
}): React.ReactNode {
  const { reading, call } = props.read
  const region = useClickRegion(() => props.onToggle(call.callId))
  const lane = (reading.gather ?? '').padEnd(LANE)
  const room = Math.max(4, props.inner - HANG.length - 2 - LANE - reading.note.length - GAP)
  const label = tailOfPath({ path: reading.line, cells: room })
  const pad = ' '.repeat(Math.max(0, room - [...label].length))

  return (
    <box flexDirection="column">
      <text wrapMode="none" width={props.inner} flexShrink={0} {...region.handlers}>
        <span fg={theme.rule} {...region.wash}>{`${HANG}  ${lane}`}</span>
        <span fg={reading.failed ? theme.error : theme.hover} {...region.wash}>
          {`${label}${pad}`}
        </span>
        <span fg={theme.rule} {...region.wash}>{`${' '.repeat(GAP)}${reading.note}`}</span>
      </text>
      {props.only || props.opened.has(call.callId) ? (
        <RunDetail
          detail={reading.detail}
          call={call}
          inner={props.inner}
          cwd={props.cwd}
          expanded={props.opened.has(moreKey(call.callId))}
          onToggle={props.onToggle}
        />
      ) : null}
    </box>
  )
}

/**
 * The last few lines a call in flight has printed.
 *
 * No `⎿` on these. It would be drawn once per line, so a three-line window puts three of them down
 * the left edge — and a blank line of output renders as a lone glyph with nothing after it. The rows
 * are already dim and already indented; the glyph says a third time what those two say.
 */
export function Streaming(props: { call: ToolCall; inner: number }): React.ReactNode {
  const shown = detailTail(props.call)
  const reserved = useHighWater({ rows: shown.length, live: true })

  return (
    <>
      {Array.from({ length: reserved }, (_unused, index) => shown[index]).map((line, index) => (
        <text key={index} wrapMode="none" width={props.inner} flexShrink={0}>
          <span fg={index === shown.length - 1 ? theme.hint : theme.rule}>
            {line === undefined
              ? ' '
              : `${HANG}${tailOfPath({ path: line, cells: Math.max(8, props.inner - HANG.length) })}`}
          </span>
        </text>
      ))}
    </>
  )
}

const detailTail = (call: ToolCall): readonly string[] =>
  call.modelText.length === 0 ? [] : call.modelText.split('\n').slice(-STREAM_TAIL)
