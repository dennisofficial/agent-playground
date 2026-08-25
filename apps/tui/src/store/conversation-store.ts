import type { BranchId, Event } from '@dltech/atlas-core'
import type { ChannelSignal, DeltaChannel, Unsubscribe } from '@dltech/atlas-harness'

import { deriveTranscript } from './derive-transcript'
import { prunedSignals } from './in-flight-steps'
import type { TranscriptModel } from './transcript-model'

export type ConversationStore = {
  subscribe(listener: () => void): Unsubscribe
  getSnapshot(): TranscriptModel
  setEvents(events: readonly Event[]): void
  dispose(): void
}

const NO_SIGNALS: readonly ChannelSignal[] = Object.freeze([])

export function createConversationStore(args: {
  channel: DeltaChannel
  branchId: BranchId
  events?: readonly Event[]
}): ConversationStore {
  let events: readonly Event[] = args.events ?? []
  let signals: readonly ChannelSignal[] = NO_SIGNALS
  let model = deriveTranscript({ events, signals })

  const listeners = new Set<() => void>()

  const republish = () => {
    signals = prunedSignals({ signals, events })
    model = deriveTranscript({ events, signals })
    for (const listener of [...listeners]) listener()
  }

  const handleSignal = (signal: ChannelSignal) => {
    signals = [...signals, signal]
    republish()
  }

  let unsubscribeFromChannel: Unsubscribe | undefined = args.channel.subscribe({
    branchId: args.branchId,
    listener: handleSignal,
  })

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    getSnapshot: () => model,

    setEvents(next) {
      events = next
      republish()
    },

    dispose() {
      unsubscribeFromChannel?.()
      unsubscribeFromChannel = undefined
      listeners.clear()
    },
  }
}
