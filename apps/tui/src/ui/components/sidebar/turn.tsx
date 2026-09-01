import React from 'react'

import type { ClassifierFold } from '../../../store/classifier-fold'
import type { SidebarModel } from '../../../store/sidebar-model'
import { formatElapsed, formatTokens, theme } from '../../theme'
import type { TurnClock } from '../transcript'
import { Row, Section } from './row'

const TOKENS_LABEL = 'tokens'

const APPROVAL_MARK = '?'

export const pausesFigure = (fold: ClassifierFold): string =>
  `${String(fold.pauses)} / ${String(fold.turns)} turns`

const tokenValue = (tokens: number) => [{ text: `↓ ${formatTokens(tokens)}`, fg: theme.hint }]

function stateOf(turn: TurnClock): string {
  if (turn.interrupting) return 'interrupting'
  return turn.retry === null ? 'working' : 'retrying'
}

function stateColourOf(turn: TurnClock): string {
  if (turn.interrupting) return theme.warn
  return turn.retry === null ? theme.ok : theme.error
}

export function TurnSection(props: {
  turn: TurnClock
  now: number
  cells: number
}): React.ReactNode {
  const { turn } = props

  if (turn.startedAt !== null) {
    return (
      <Section label="Turn">
        <Row
          label={stateOf(turn)}
          labelFg={theme.meta}
          cells={props.cells}
          value={[
            {
              text: formatElapsed(Math.max(0, props.now - turn.startedAt)),
              fg: stateColourOf(turn),
            },
          ]}
        />
        {turn.outputTokens === 0 ? null : (
          <Row
            label={TOKENS_LABEL}
            labelFg={theme.meta}
            cells={props.cells}
            value={tokenValue(turn.outputTokens)}
          />
        )}
      </Section>
    )
  }

  if (turn.completed === null) return null

  return (
    <Section label="Turn">
      <Row
        label="last turn"
        labelFg={theme.meta}
        cells={props.cells}
        value={[{ text: formatElapsed(turn.completed.durationMs), fg: theme.hint }]}
      />
      <Row
        label={TOKENS_LABEL}
        labelFg={theme.meta}
        cells={props.cells}
        value={tokenValue(turn.completed.outputTokens)}
      />
    </Section>
  )
}

function NudgeRows(props: { fold: ClassifierFold; cells: number }): React.ReactNode {
  const { fold } = props

  return (
    <>
      <Row
        label="pauses"
        labelFg={theme.meta}
        cells={props.cells}
        value={[{ text: pausesFigure(fold), fg: theme.hint }]}
      />
      {fold.topDimension === null ? null : (
        <Row
          label="most often"
          labelFg={theme.meta}
          cells={props.cells}
          value={[{ text: fold.topDimension, fg: theme.hint }]}
        />
      )}
      {fold.quietedCalls === 0 ? null : (
        <Row
          label="went quiet"
          labelFg={theme.meta}
          cells={props.cells}
          value={[{ text: String(fold.quietedCalls), fg: theme.hint }]}
        />
      )}
    </>
  )
}

export function ApprovalsSection(props: {
  model: SidebarModel
  cells: number
}): React.ReactNode {
  const { approvals, classifier } = props.model
  if (approvals.length === 0 && classifier === undefined) return null

  return (
    <Section
      label="Approvals"
      {...(approvals.length === 0 ? {} : { count: String(approvals.length) })}
    >
      {approvals.map((approval) => (
        <Row
          key={approval.callId}
          label={approval.reason}
          labelFg={theme.hover}
          cells={props.cells}
          mark={{ text: APPROVAL_MARK, fg: theme.warn }}
        />
      ))}
      {classifier === undefined ? null : <NudgeRows fold={classifier} cells={props.cells} />}
    </Section>
  )
}
