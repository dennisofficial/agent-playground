import React from 'react'

import { backgroundWaitLabel, type BackgroundWork } from '../background-wait'
import { retryLabel, type RetryWait } from '../retry-countdown'
import { formatElapsed, formatTokens, theme } from '../theme'
import { ShimmerLine, SpinnerGlyph } from './shimmer-line'

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
  const { retry } = props

  if (retry !== null && retry !== undefined && !props.interrupting) {
    return (
      <box flexDirection="column">
        <ShimmerLine label={retryLabel({ retry, now: Date.now() })} base={theme.error} />
      </box>
    )
  }

  if (props.interrupting) {
    return (
      <box flexDirection="column">
        <text fg={theme.dim}>
          <SpinnerGlyph fg={theme.accent} />
          {` ${INTERRUPTING}`}
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
      <ShimmerLine label={label} />
    </box>
  )
}

/**
 * The complement of the working line, and never shown beside it: the turn has settled, but what it
 * started has not, so the transcript keeps a live row rather than looking finished while it isn't.
 *
 * `since` is when the wait began and is held by whoever outlives this line, because the transcript
 * unmounts whenever the operator opens a sub-agent: measured here, the reading would restart from
 * the moment they walked back in. The re-renders that count the wait up come from the shells tick
 * above this component, so the label reads the wall clock rather than a clock of its own.
 */
export function WaitingLine(props: {
  work: BackgroundWork
  since?: number | null
}): React.ReactNode {
  const since = props.since ?? null
  const label = backgroundWaitLabel({
    work: props.work,
    ...(since === null ? {} : { waitedMs: Math.max(0, Date.now() - since) }),
  })
  if (label === null) return null

  return (
    <box flexDirection="row" marginTop={1} marginBottom={1}>
      <ShimmerLine label={label} />
    </box>
  )
}
