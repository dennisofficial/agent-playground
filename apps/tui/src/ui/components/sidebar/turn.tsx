import React from 'react'

import type { SidebarModel } from '../../../store/sidebar-model'
import { formatElapsed, formatTokens, glyph, theme } from '../../theme'
import type { TurnClock } from '../transcript'
import { Row, Section } from './row'

const TOKENS_LABEL = 'tokens'

const APPROVAL_MARK = '?'

const tokenValue = (tokens: number) => [{ text: `↓ ${formatTokens(tokens)}`, fg: theme.hint }]

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
          label={turn.interrupting ? 'interrupting' : 'working'}
          labelFg={theme.meta}
          cells={props.cells}
          value={[
            {
              text: formatElapsed(Math.max(0, props.now - turn.startedAt)),
              fg: turn.interrupting ? theme.warn : theme.ok,
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

export function ApprovalsSection(props: {
  model: SidebarModel
  cells: number
}): React.ReactNode {
  const { approvals } = props.model
  if (approvals.length === 0) return null

  return (
    <Section label="Approvals" count={String(approvals.length)}>
      {approvals.map((approval) => (
        <Row
          key={approval.callId}
          label={approval.reason}
          labelFg={theme.hover}
          cells={props.cells}
          mark={{ text: APPROVAL_MARK, fg: theme.warn }}
        />
      ))}
    </Section>
  )
}

export function ToolCallsSection(props: {
  model: SidebarModel
  cells: number
}): React.ReactNode {
  const { toolCalls } = props.model
  if (toolCalls.length === 0) return null

  return (
    <Section label="Tool calls" count={String(toolCalls.length)}>
      {toolCalls.map((call) => (
        <Row
          key={call.callId}
          label={call.name}
          labelFg={theme.hover}
          cells={props.cells}
          mark={{ text: glyph.active, fg: theme.accent }}
        />
      ))}
    </Section>
  )
}
