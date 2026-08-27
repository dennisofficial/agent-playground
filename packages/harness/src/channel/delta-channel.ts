import type { ThreadId, ChunkFilter, Event, EventOfType, EventRef } from '@dltech/atlas-core'

import { EStepEnd, toStepId, type ChannelSignal, type StepId, type StepSignal } from './signal'

export type ChannelListener = (signal: ChannelSignal) => void

export type Unsubscribe = () => void

export type ThreadPublisher = {
  readonly threadId: ThreadId
  readonly onChunk: ChunkFilter
  settleAppend(args: { events: readonly Event[] }): void
  close(args: { end: EStepEnd }): void
}

export type DeltaChannel = {
  subscribe(args: { threadId: ThreadId; listener: ChannelListener }): Unsubscribe
  snapshot(args: { threadId: ThreadId }): readonly ChannelSignal[]
  publisherFor(args: { threadId: ThreadId; filter?: ChunkFilter | undefined }): ThreadPublisher
}

type ThreadState = {
  listeners: Set<ChannelListener>
  inFlight: readonly StepSignal[]
  stepId: StepId | undefined
  stepsStarted: number
}

const NOTHING_IN_FLIGHT: readonly StepSignal[] = Object.freeze([])

const durableAssistantEvent = (events: readonly Event[]): EventOfType<'assistant-said'> | undefined =>
  events.find((event): event is EventOfType<'assistant-said'> => event.type === 'assistant-said')

const refOf = (event: EventOfType<'assistant-said'> | undefined): EventRef | null =>
  event === undefined ? null : { eventId: event.id, seq: event.seq }

const needsAStepToFailIn = (args: { state: ThreadState; end: EStepEnd }): boolean =>
  args.state.stepId === undefined && args.end === EStepEnd.Failed

const endOf = (event: EventOfType<'assistant-said'> | undefined): EStepEnd =>
  event?.interrupted === true ? EStepEnd.Interrupted : EStepEnd.Completed

export function createDeltaChannel(): DeltaChannel {
  const threads = new Map<ThreadId, ThreadState>()

  const stateFor = (threadId: ThreadId): ThreadState => {
    const existing = threads.get(threadId)
    if (existing !== undefined) return existing

    const created: ThreadState = {
      listeners: new Set(),
      inFlight: NOTHING_IN_FLIGHT,
      stepId: undefined,
      stepsStarted: 0,
    }
    threads.set(threadId, created)
    return created
  }

  const forgetIfIdle = (args: { threadId: ThreadId; state: ThreadState }) => {
    if (args.state.listeners.size > 0 || args.state.stepId !== undefined) return
    threads.delete(args.threadId)
  }

  const notify = (args: { state: ThreadState; signal: ChannelSignal }) => {
    for (const listener of [...args.state.listeners]) listener(args.signal)
  }

  const publish = (args: { state: ThreadState; signal: StepSignal }) => {
    args.state.inFlight = [...args.state.inFlight, args.signal]
    notify(args)
  }

  const startStep = (args: { threadId: ThreadId; state: ThreadState }): StepId => {
    args.state.stepsStarted += 1
    const stepId = toStepId(`${args.threadId}#${args.state.stepsStarted}`)
    args.state.stepId = stepId
    publish({ state: args.state, signal: { type: 'step-started', stepId } })
    return stepId
  }

  const endStep = (args: {
    threadId: ThreadId
    state: ThreadState
    end: EStepEnd
    supersededBy: EventRef | null
  }): boolean => {
    const stepId = args.state.stepId
    if (stepId === undefined) return false

    args.state.stepId = undefined
    args.state.inFlight = NOTHING_IN_FLIGHT
    notify({
      state: args.state,
      signal: { type: 'step-ended', stepId, end: args.end, supersededBy: args.supersededBy },
    })
    forgetIfIdle({ threadId: args.threadId, state: args.state })
    return true
  }

  return {
    subscribe({ threadId, listener }) {
      const state = stateFor(threadId)
      for (const signal of state.inFlight) listener(signal)
      state.listeners.add(listener)

      return () => {
        state.listeners.delete(listener)
        forgetIfIdle({ threadId, state })
      }
    },

    snapshot({ threadId }) {
      return threads.get(threadId)?.inFlight ?? NOTHING_IN_FLIGHT
    },

    publisherFor({ threadId, filter }) {
      return {
        threadId,

        onChunk(chunk) {
          const kept = filter === undefined ? chunk : filter(chunk)
          if (kept === null) return null

          const state = stateFor(threadId)
          const stepId = state.stepId ?? startStep({ threadId, state })
          publish({ state, signal: { type: 'chunk', stepId, chunk: kept } })
          return kept
        },

        settleAppend({ events }) {
          const state = threads.get(threadId)
          if (state === undefined) return

          const durable = durableAssistantEvent(events)
          const ended = endStep({ threadId, state, end: endOf(durable), supersededBy: refOf(durable) })
          if (!ended) notify({ state, signal: { type: 'events-appended' } })
        },

        close({ end }) {
          const state = threads.get(threadId)
          if (state === undefined) return

          if (needsAStepToFailIn({ state, end })) startStep({ threadId, state })
          endStep({ threadId, state, end, supersededBy: null })
        },
      }
    },
  }
}
