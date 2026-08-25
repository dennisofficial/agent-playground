import type { Event, EventOfType } from '@dltech/atlas-core'

import type { ChannelSignal, StepId } from '..'

export type Recorder = { readonly seen: ChannelSignal[]; listener: (signal: ChannelSignal) => void }

export function recorder(): Recorder {
  const seen: ChannelSignal[] = []
  return { seen, listener: (signal: ChannelSignal) => void seen.push(signal) }
}

export function firstStepId(signals: readonly ChannelSignal[]): StepId {
  const started = signals.find((signal) => signal.type === 'step-started')
  if (started === undefined) throw new Error('no step was started')
  return started.stepId
}

export function stepEnded(signals: readonly ChannelSignal[]): Extract<ChannelSignal, { type: 'step-ended' }> {
  const ended = signals.find((signal): signal is Extract<ChannelSignal, { type: 'step-ended' }> =>
    signal.type === 'step-ended',
  )
  if (ended === undefined) throw new Error('no step ended')
  return ended
}

export function assistantEvent(events: readonly Event[]): EventOfType<'assistant-said'> {
  const found = events.find((event): event is EventOfType<'assistant-said'> => event.type === 'assistant-said')
  if (found === undefined) throw new Error('no assistant event')
  return found
}
