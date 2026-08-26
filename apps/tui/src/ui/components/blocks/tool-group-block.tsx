import React from 'react'

import { EGroupState, type ToolCallRow, type ToolGroup } from '../../../store'
import { useClickRegion } from '../../hooks/use-click-region'
import { useShimmerClock } from '../../hooks/use-shimmer-clock'
import { tailOfPath } from '../../paths'
import { glyph, spinnerFrame, theme, TRANSCRIPT_INSET } from '../../theme'
import {
  elapsedSpans,
  fitSpans,
  GAP,
  INDENT,
  itemDetail,
  nameOf,
  railColour,
  settledDetail,
  spanCells,
} from '../../tool-group-spans'
import { Spans, type Span } from '../spans'

const NARROWEST_BAND = 24

/** Lines the group up under the `⏺` that asked for it, as `AssistantBlock` sets its own mark. */
const MARK_COLUMNS = 2

const LIVE_TAIL = 2

function Row(props: {
  left: readonly Span[]
  right: readonly Span[]
  inner: number
}): React.ReactNode {
  const right = fitSpans({ spans: props.right, cells: props.inner })
  const rightCells = spanCells(right)
  const left = fitSpans({ spans: props.left, cells: Math.max(0, props.inner - rightCells - GAP) })
  const gap = Math.max(0, props.inner - spanCells(left) - rightCells)

  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      <Spans spans={left} />
      <span>{' '.repeat(gap)}</span>
      <Spans spans={right} />
    </text>
  )
}

function ItemRow(props: { row: ToolCallRow; inner: number }): React.ReactNode {
  const detail = itemDetail(props.row)
  const cells = Math.max(1, props.inner - INDENT.length - spanCells(detail) - GAP)

  return (
    <Row
      inner={props.inner}
      left={[
        { text: INDENT },
        { text: tailOfPath({ path: nameOf(props.row), cells }), fg: theme.hint },
      ]}
      right={detail}
    />
  )
}

function SettledRows(props: {
  group: ToolGroup
  inner: number
  now: number
  expandable: boolean
  expanded: boolean
}): React.ReactNode {
  return (
    <>
      <Row
        inner={props.inner}
        left={[
          { text: glyph.result, fg: railColour(props.group) },
          { text: ' ' },
          { text: props.group.label, fg: theme.hover },
        ]}
        right={settledDetail(props)}
      />
      {props.expanded
        ? props.group.calls.map((row) => <ItemRow key={row.callId} row={row} inner={props.inner} />)
        : null}
    </>
  )
}

function LiveCallRow(props: {
  group: ToolGroup
  row: ToolCallRow
  inner: number
  now: number
}): React.ReactNode {
  return (
    <Row
      inner={props.inner}
      left={[
        { text: spinnerFrame(props.now), fg: theme.accent },
        { text: ' ' },
        { text: props.group.verb.spelling, fg: theme.code },
        { text: ' ' },
        { text: nameOf(props.row), fg: theme.hover },
      ]}
      right={elapsedSpans({ group: props.group, now: props.now })}
    />
  )
}

function LiveRows(props: { group: ToolGroup; inner: number; now: number }): React.ReactNode {
  const { group } = props
  const only = group.calls.length === 1 ? group.calls[0] : undefined
  if (only !== undefined) {
    return <LiveCallRow group={group} row={only} inner={props.inner} now={props.now} />
  }

  const tail = group.calls.slice(-LIVE_TAIL)

  return (
    <>
      <Row
        inner={props.inner}
        left={[
          { text: spinnerFrame(props.now), fg: theme.accent },
          { text: ' ' },
          { text: group.label, fg: theme.hover },
        ]}
        right={[{ text: `${group.totals.settled} of ~${group.totals.count}`, fg: theme.hint }]}
      />
      {tail.map((row, index) => (
        <Row
          key={row.callId}
          inner={props.inner}
          left={[
            { text: INDENT },
            {
              text: tailOfPath({ path: nameOf(row), cells: props.inner - INDENT.length }),
              fg: index === tail.length - 1 ? theme.hint : theme.rule,
            },
          ]}
          right={[]}
        />
      ))}
    </>
  )
}

export function ToolGroupBlock(props: {
  group: ToolGroup
  width: number
  now?: number
  expanded?: boolean
  onToggle?: () => void
}): React.ReactNode {
  const { group } = props
  const live = group.state === EGroupState.Live
  const clock = useShimmerClock({ active: live && props.now === undefined })
  const now = props.now ?? clock
  const inner = Math.max(NARROWEST_BAND, props.width - TRANSCRIPT_INSET - MARK_COLUMNS)
  const expandable = !live && group.calls.length > 0
  const { handlers, wash } = useClickRegion(expandable ? props.onToggle : undefined)

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      marginLeft={MARK_COLUMNS}
      width={inner}
      flexShrink={0}
      {...(wash.bg === undefined ? {} : { backgroundColor: wash.bg })}
      {...handlers}
    >
      {live ? (
        <LiveRows group={group} inner={inner} now={now} />
      ) : (
        <SettledRows
          group={group}
          inner={inner}
          now={now}
          expandable={expandable}
          expanded={props.expanded === true}
        />
      )}
    </box>
  )
}
