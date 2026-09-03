import React from 'react'

import { backgroundWaitLabel, isWaiting, type BackgroundWork } from '../background-wait'
import { useShimmerClock } from '../hooks/use-shimmer-clock'
import { beaconHeat, shimmerCrest, WORKING_SHIMMER } from '../shimmer'
import { retryLabel, type RetryWait } from '../retry-countdown'
import { shimmerColour, shimmerSpans } from '../shimmer-style'
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
  retry?: RetryWait | null | undefined
}): React.ReactNode {
  const now = useShimmerClock({ active: true })
  const { retry } = props

  if (retry !== null && retry !== undefined && !props.interrupting) {
    return (
      <box flexDirection="column">
        <ShimmeringLine label={retryLabel({ retry, now })} now={now} base={theme.error} />
      </box>
    )
  }

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

/**
 * The complement of the working line, and never shown beside it: the turn has settled, but what it
 * started has not, so the transcript keeps a live row rather than looking finished while it isn't.
 *
 * `since` is when the wait began and is held by whoever outlives this line, because the transcript
 * unmounts whenever the operator opens a sub-agent: measured here, the reading would restart from
 * the moment they walked back in. The fast clock stays local — the origin is the durable half.
 */
export function WaitingLine(props: {
  work: BackgroundWork
  since?: number | null
}): React.ReactNode {
  const waiting = isWaiting(props.work)
  const since = props.since ?? null
  const now = useShimmerClock({ active: waiting })
  const label = backgroundWaitLabel({
    work: props.work,
    ...(since === null ? {} : { waitedMs: Math.max(0, now - since) }),
  })
  if (label === null) return null

  return (
    <box flexDirection="row" marginTop={1} marginBottom={1}>
      <ShimmeringLine label={label} now={now} />
    </box>
  )
}

const TEXT_OFFSET = 2

function ShimmeringLine(props: { label: string; now: number; base?: string }): React.ReactNode {
  const cells = [...props.label].length + TEXT_OFFSET
  const crest = shimmerCrest({ nowMs: props.now, cells, spec: WORKING_SHIMMER })

  return (
    <text>
      <span fg={shimmerColour(beaconHeat({ crest, spec: WORKING_SHIMMER }), props.base)}>
        {spinnerFrame(props.now)}
      </span>
      <span> </span>
      <Spans
        spans={shimmerSpans({
          text: props.label,
          crest,
          spec: WORKING_SHIMMER,
          offset: TEXT_OFFSET,
          ...(props.base === undefined ? {} : { base: props.base }),
        })}
      />
    </text>
  )
}
