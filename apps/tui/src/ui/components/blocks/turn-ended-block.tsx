import React from 'react'

import { formatClockTime, formatElapsed, formatTokens, glyph, theme } from '../../theme'

const STOPPED = 'Stopped after'

const WORKED = 'Worked for'

export function TurnEndedBlock(props: {
  durationMs: number
  outputTokens: number
  endedAt: string
  interrupted: boolean
}): React.ReactNode {
  const verb = props.interrupted ? STOPPED : WORKED
  const tokens = props.outputTokens > 0 ? ` (↓ ${formatTokens(props.outputTokens)} tokens)` : ''
  const at = formatClockTime(props.endedAt)

  return (
    <box flexDirection="row" marginBottom={1} flexShrink={0}>
      <text fg={theme.dim}>
        <span fg={theme.dim}>{glyph.thinking}</span>{' '}
        {`${verb} ${formatElapsed(props.durationMs)}${tokens}${at === '' ? '' : ` at ${at}`}`}
      </text>
    </box>
  )
}
