import React from 'react'

import { formatElapsed, formatTokens, theme } from '../../theme'
import type { TurnClock } from '../transcript'
import { Row, Section } from './row'

const TOKENS_LABEL = 'tokens'

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
