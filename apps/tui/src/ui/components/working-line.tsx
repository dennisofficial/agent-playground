import React from 'react'

import { useShimmerClock } from '../hooks/use-shimmer-clock'
import { beaconHeat, shimmerCrest, WORKING_SHIMMER } from '../shimmer'
import { beaconColour, shimmerSpans } from '../shimmer-style'
import { formatElapsed, formatTokens, spinnerFrame, theme } from '../theme'
import { Spans } from './spans'

export enum EWorkingVerb {
  Working = 'Working',
  Thinking = 'Thinking',
  Compacting = 'Compacting',
}

const INTERRUPTING = 'Interrupting…'

/**
 * Only ever shown while something is running. What a finished turn cost is a durable transcript
 * row built from the ledger, not this line settling in place.
 */
export function WorkingLine(props: {
  elapsedMs: number
  outputTokens: number
  interrupting: boolean
  verb?: EWorkingVerb | undefined
}): React.ReactNode {
  const now = useShimmerClock({ active: true })

  if (props.interrupting) {
    return (
      <box flexDirection="column">
        <text fg={theme.dim}>
          <span fg={theme.accent}>{spinnerFrame(now)}</span> {INTERRUPTING}
        </text>
      </box>
    )
  }

  const verb = props.verb ?? EWorkingVerb.Working
  const tokens =
    props.outputTokens > 0 ? `↓ ${formatTokens(props.outputTokens)} tokens · ` : ''
  const label = `${verb} for ${formatElapsed(props.elapsedMs)} (${tokens}esc to interrupt)`

  return (
    <box flexDirection="column">
      <ShimmeringLine label={label} now={now} />
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
