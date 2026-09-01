import React from 'react'

import type { RecoveredAgents } from '@dltech/atlas-harness'

import {
  lostChildCount,
  lostChildRows,
  LOST_CHILDREN_EXPLANATION,
  LOST_CHILDREN_TITLE,
  LOST_CHILDREN_UNREACHABLE,
} from '../lost-children-model'
import { formatClockTime, glyph, theme } from '../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from './panel'
import { wrapCells } from './sidebar/cells'

const CHROME_COLUMNS = PANEL_INSET + PANEL_PAD

const MARK_COLUMNS = 2

function Prose(props: { text: string; fg: string; cells: number }): React.ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      {wrapCells({ text: props.text, cells: props.cells }).map((line) => (
        <text key={line} fg={props.fg}>
          {line}
        </text>
      ))}
    </box>
  )
}

/**
 * Named and timed, and nothing more. There is no route from here to the thread and deliberately so:
 * an affordance beside the name would read as a promise this conversation cannot keep.
 */
function LostRow(props: { name: string; startedAt: string }): React.ReactNode {
  const at = formatClockTime(props.startedAt)

  return (
    <text>
      <span fg={theme.warn}>{glyph.warning}</span>
      <span>{' '}</span>
      <span fg={theme.body}>{props.name}</span>
      {at === '' ? null : <span fg={theme.dim}>{`  opened ${at}`}</span>}
    </text>
  )
}

/**
 * A recovery notice rather than an alarm: the conversation opened, everything else in it is intact,
 * and the operator's next move is to look at their working tree rather than at Atlas.
 */
export function LostChildren(props: {
  width: number
  lost: RecoveredAgents | null
}): React.ReactNode {
  const rows = lostChildRows(props.lost)
  if (rows.length === 0) return null

  const cells = Math.max(0, props.width - CHROME_COLUMNS)

  return (
    <Panel
      width={props.width}
      fill={theme.overlayBg}
      label={
        <text fg={theme.warn} bg={theme.overlayBg}>{` ${LOST_CHILDREN_TITLE} `}</text>
      }
      badge={
        <text fg={theme.hint} bg={theme.overlayBg}>{` ${lostChildCount(rows)} `}</text>
      }
    >
      <box flexDirection="column" flexShrink={0} gap={1}>
        <box flexDirection="column" flexShrink={0}>
          {rows.map((row) => (
            <LostRow key={row.id} name={row.name} startedAt={row.startedAt} />
          ))}
        </box>
        <Prose
          text={LOST_CHILDREN_EXPLANATION}
          fg={theme.body}
          cells={Math.max(0, cells - MARK_COLUMNS)}
        />
        <Prose
          text={LOST_CHILDREN_UNREACHABLE}
          fg={theme.hint}
          cells={Math.max(0, cells - MARK_COLUMNS)}
        />
      </box>
    </Panel>
  )
}
