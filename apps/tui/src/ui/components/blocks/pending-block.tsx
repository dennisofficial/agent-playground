import React from 'react'

import { EPendingKind, type PendingRow } from '../../../store'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'
import { UserBlock } from './user-block'

type NoticeKind = EPendingKind.BackgroundShell | EPendingKind.Agent | EPendingKind.Service

type PendingRun =
  | { kind: EPendingKind.Operator; id: string; said: readonly string[]; takeBack: boolean }
  | { kind: NoticeKind; id: string; text: string; failed: boolean }

/**
 * Consecutive queued messages share one panel, the way the transcript gives one panel to
 * consecutive things the operator said — four one-word messages must not stack four panels high.
 */
export function pendingRuns(rows: readonly PendingRow[]): readonly PendingRun[] {
  const runs: PendingRun[] = []

  for (const row of rows) {
    if (row.kind !== EPendingKind.Operator) {
      runs.push({ kind: row.kind, id: row.id, text: row.text, failed: row.failed })
      continue
    }

    const open = runs.at(-1)
    if (open?.kind === EPendingKind.Operator) {
      open.said = [...open.said, row.text]
      open.takeBack = !row.taken
      continue
    }

    runs.push({ kind: row.kind, id: row.id, said: [row.text], takeBack: !row.taken })
  }

  return runs
}

export function PendingBlock(props: {
  rows: readonly PendingRow[]
  width: number
}): React.ReactNode {
  if (props.rows.length === 0) return null

  return (
    <box flexDirection="column" flexShrink={0}>
      {pendingRuns(props.rows).map((run) =>
        run.kind === EPendingKind.Operator ? (
          <UserBlock
            key={run.id}
            said={run.said}
            width={props.width}
            {...(run.takeBack ? { takeBack: true } : {})}
          />
        ) : (
          <WaitingNoticeRow key={run.id} text={run.text} failed={run.failed} width={props.width} />
        ),
      )}
    </box>
  )
}

/**
 * Nobody typed this, so it carries no take-back affordance: it is waiting to be handed to the model,
 * not waiting to be sent. It reads exactly as it will once the transcript lands it — the queue only
 * moves it under the working line, it does not restyle it.
 */
function WaitingNoticeRow(props: {
  text: string
  failed: boolean
  width: number
}): React.ReactNode {
  const inner = Math.max(1, props.width - TRANSCRIPT_INSET)

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <text wrapMode="none" width={inner} flexShrink={0}>
        <span fg={props.failed ? theme.error : theme.ok}>{`${glyph.block} `}</span>
        <span fg={theme.meta}>{props.text}</span>
      </text>
    </box>
  )
}
