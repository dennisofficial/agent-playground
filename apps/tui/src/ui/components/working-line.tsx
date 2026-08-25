import React from 'react'

import { useShimmerClock } from '../hooks/use-shimmer-clock'
import { beaconHeat, shimmerCrest, WORKING_SHIMMER } from '../shimmer'
import { beaconColour, shimmerSpans } from '../shimmer-style'
import { formatElapsed, formatTokens, glyph, spinnerFrame, theme } from '../theme'
import { Spans } from './spans'

export function WorkingLine(props: {
  running: boolean
  elapsedMs: number
  outputTokens: number
  interrupting: boolean
}): React.ReactNode {
  const shimmering = props.running && !props.interrupting
  const now = useShimmerClock({ active: props.running })

  const elapsed = formatElapsed(props.elapsedMs)
  const tokens = props.outputTokens > 0 ? `↓ ${formatTokens(props.outputTokens)} tokens` : ''
  const detail = props.running ? `${tokens ? `${tokens} · ` : ''}esc to interrupt` : tokens
  const label = `${props.running ? 'Working' : 'Worked'} for ${elapsed}${detail ? ` (${detail})` : ''}`

  return (
    <box flexDirection="column">
      {shimmering ? (
        <ShimmeringLine label={label} now={now} />
      ) : (
        <text fg={theme.dim}>
          <span fg={props.interrupting ? theme.accent : theme.dim}>
            {props.interrupting ? spinnerFrame(now) : glyph.thinking}
          </span>{' '}
          {props.interrupting ? 'Interrupting…' : label}
        </text>
      )}
    </box>
  )
}

const TEXT_OFFSET = 2

function ShimmeringLine(props: { label: string; now: number }): React.ReactNode {
  const cells = [...props.label].length + TEXT_OFFSET
  const crest = shimmerCrest({ nowMs: props.now, cells, spec: WORKING_SHIMMER })

  return (
    <text>
      <span fg={beaconColour(beaconHeat({ crest, spec: WORKING_SHIMMER }))}>
        {spinnerFrame(props.now)}
      </span>
      <span> </span>
      <Spans
        spans={shimmerSpans({
          text: props.label,
          crest,
          spec: WORKING_SHIMMER,
          offset: TEXT_OFFSET,
        })}
      />
    </text>
  )
}
