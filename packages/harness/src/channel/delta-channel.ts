import type { ThreadId, ChunkFilter, Event, EventOfType, EventRef } from '@dltech/atlas-core'

import {
  EStepEnd,
  toStepId,
  type ChannelSignal,
  type RetryWaitingSignal,
  type StepId,
  type StepSignal,
} from './signal'

export type ChannelListener = (signal: ChannelSignal) => void

export type Unsubscribe = () => void

export type ThreadPublisher = {
  readonly threadId: ThreadId
  readonly onChunk: ChunkFilter
  settleAppend(args: { events: readonly Event[] }): void
  close(args: { end: EStepEnd }): void
  retrying(notice: Omit<RetryWaitingSignal, 'type'>): void
}

export type DeltaChannel = {
  subscribe(args: { threadId: ThreadId; listener: ChannelListener }): Unsubscribe
  snapshot(args: { threadId: ThreadId }): readonly ChannelSignal[]
  publisherFor(args: { threadId: ThreadId; filter?: ChunkFilter | undefined }): ThreadPublisher
}

type ThreadState = {
  listeners: Set<ChannelListener>
  inFlight: StepSignal[]
  replay: readonly StepSignal[] | undefined
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
      inFlight: [],
      replay: undefined,
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

  const stableReplay = (state: ThreadState): readonly StepSignal[] => {
    if (state.inFlight.length === 0) return NOTHING_IN_FLIGHT
    if (state.replay !== undefined) return state.replay
    state.replay = Object.freeze([...state.inFlight])
    return state.replay
  }

  const publish = (args: { state: ThreadState; signal: StepSignal }) => {
    args.state.inFlight.push(args.signal)
    args.state.replay = undefined
    notify(args)
  }

  const startStep = (args: { threadId: ThreadId; state: ThreadState }): StepId => {
    args.state.stepsStarted += 1
    const stepId = toStepId(`${args.threadId}#${args.state.stepsStarted}`)
    args.state.stepId = stepId
    args.state.inFlight = []
    args.state.replay = undefined
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
    args.state.inFlight = []
    args.state.replay = undefined
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
      for (const signal of stableReplay(state)) listener(signal)
      state.listeners.add(listener)

      return () => {
        state.listeners.delete(listener)
        forgetIfIdle({ threadId, state })
      }
    },

    snapshot({ threadId }) {
      const state = threads.get(threadId)
      if (state === undefined) return NOTHING_IN_FLIGHT
      return stableReplay(state)
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

        retrying(notice) {
          const state = stateFor(threadId)
          endStep({ threadId, state, end: EStepEnd.Retried, supersededBy: null })
          notify({ state: stateFor(threadId), signal: { type: 'retry-waiting', ...notice } })
        },
      }
    },
  }
}
