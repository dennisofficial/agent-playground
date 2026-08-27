import type { BranchId, Event } from '@dltech/atlas-core'
import type { ChannelSignal, DeltaChannel, StepSignal, Unsubscribe } from '@dltech/atlas-harness'

import { IDLE_TURN, type TurnClock } from '../ui/components/transcript'
import { deriveTranscript } from './derive-transcript'
import { prunedSignals, withoutFailedTail } from './in-flight-steps'
import {
  advancedGate,
  attachedGate,
  FRAME_MS,
  gateIsDraining,
  tailRunOf,
  type RevealGate,
} from './reveal'
import { deriveSidebar, type SidebarModel } from './sidebar-model'
import { SHIPPED_THINKING, type EThinkingVisibility } from './thinking-fold'
import type { TranscriptModel } from './transcript-model'

export type ConversationStore = {
  subscribe(listener: () => void): Unsubscribe
  getSnapshot(): TranscriptModel
  getSidebar(): SidebarModel
  setEvents(events: readonly Event[]): void
  setTurn(turn: TurnClock): void
  supersedeFailure(): void
  setThinking(thinking: EThinkingVisibility): void
  setName(name: string | null): void
  dispose(): void
}

const NO_SIGNALS: readonly StepSignal[] = Object.freeze([])

export function createConversationStore(args: {
  channel: DeltaChannel
  branchId: BranchId
  events?: readonly Event[]
  paceReveal?: boolean
  thinking?: EThinkingVisibility
  name?: string | null
}): ConversationStore {
  const paceReveal = args.paceReveal ?? false
  let thinking: EThinkingVisibility = args.thinking ?? SHIPPED_THINKING
  let name: string | null = args.name ?? null
  let events: readonly Event[] = args.events ?? []
  let signals: readonly StepSignal[] = NO_SIGNALS
  let turn: TurnClock = IDLE_TURN
  let gate: RevealGate | null = null
  let frame: ReturnType<typeof setTimeout> | undefined
  let model = deriveTranscript({ events, signals, thinking })
  let sidebar = deriveSidebar({ events, turn, name })

  const listeners = new Set<() => void>()

  const republish = () => {
    signals = prunedSignals({ signals, events })
    model = deriveTranscript({ events, signals, reveal: gate, thinking })
    sidebar = deriveSidebar({ events, turn, name })
    for (const listener of [...listeners]) listener()
  }

  const scheduleFrame = () => {
    if (frame !== undefined) return

    frame = setTimeout(() => {
      frame = undefined
      const tail = tailRunOf({ events, signals })
      gate = advancedGate({ gate, tail })
      republish()
      if (gateIsDraining({ gate, tail })) scheduleFrame()
    }, FRAME_MS)
  }

  const handleSignal = (signal: ChannelSignal) => {
    if (signal.type === 'events-appended') return

    signals = [...signals, signal]

    if (!paceReveal || signal.type !== 'chunk') {
      gate = null
      republish()
      return
    }

    gate = attachedGate({ gate, tail: tailRunOf({ events, signals }) })
    scheduleFrame()
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

    getSidebar: () => sidebar,

    setEvents(next) {
      events = next
      republish()
    },

    setTurn(next) {
      turn = next
      republish()
    },

    supersedeFailure() {
      const kept = withoutFailedTail({ signals, events })
      if (kept === signals) return

      signals = kept
      republish()
    },

    setThinking(next) {
      if (next === thinking) return
      thinking = next
      republish()
    },

    setName(next) {
      if (next === name) return
      name = next
      republish()
    },

    dispose() {
      if (frame !== undefined) clearTimeout(frame)
      frame = undefined
      unsubscribeFromChannel?.()
      unsubscribeFromChannel = undefined
      listeners.clear()
    },
  }
}
