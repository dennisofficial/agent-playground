import type { BranchId, ChunkFilter, Event, EventOfType, EventRef } from '@dltech/atlas-core'

import { EStepEnd, toStepId, type ChannelSignal, type StepId, type StepSignal } from './signal'

export type ChannelListener = (signal: ChannelSignal) => void

export type Unsubscribe = () => void

export type BranchPublisher = {
  readonly branchId: BranchId
  readonly onChunk: ChunkFilter
  settleAppend(args: { events: readonly Event[] }): void
  close(args: { end: EStepEnd }): void
}

export type DeltaChannel = {
  subscribe(args: { branchId: BranchId; listener: ChannelListener }): Unsubscribe
  snapshot(args: { branchId: BranchId }): readonly ChannelSignal[]
  publisherFor(args: { branchId: BranchId; filter?: ChunkFilter | undefined }): BranchPublisher
}

type BranchState = {
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

const needsAStepToFailIn = (args: { state: BranchState; end: EStepEnd }): boolean =>
  args.state.stepId === undefined && args.end === EStepEnd.Failed

const endOf = (event: EventOfType<'assistant-said'> | undefined): EStepEnd =>
  event?.interrupted === true ? EStepEnd.Interrupted : EStepEnd.Completed

export function createDeltaChannel(): DeltaChannel {
  const branches = new Map<BranchId, BranchState>()

  const stateFor = (branchId: BranchId): BranchState => {
    const existing = branches.get(branchId)
    if (existing !== undefined) return existing

    const created: BranchState = {
      listeners: new Set(),
      inFlight: NOTHING_IN_FLIGHT,
      stepId: undefined,
      stepsStarted: 0,
    }
    branches.set(branchId, created)
    return created
  }

  const forgetIfIdle = (args: { branchId: BranchId; state: BranchState }) => {
    if (args.state.listeners.size > 0 || args.state.stepId !== undefined) return
    branches.delete(args.branchId)
  }

  const notify = (args: { state: BranchState; signal: ChannelSignal }) => {
    for (const listener of [...args.state.listeners]) listener(args.signal)
  }

  const publish = (args: { state: BranchState; signal: StepSignal }) => {
    args.state.inFlight = [...args.state.inFlight, args.signal]
    notify(args)
  }

  const startStep = (args: { branchId: BranchId; state: BranchState }): StepId => {
    args.state.stepsStarted += 1
    const stepId = toStepId(`${args.branchId}#${args.state.stepsStarted}`)
    args.state.stepId = stepId
    publish({ state: args.state, signal: { type: 'step-started', stepId } })
    return stepId
  }

  const endStep = (args: {
    branchId: BranchId
    state: BranchState
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
    forgetIfIdle({ branchId: args.branchId, state: args.state })
    return true
  }

  return {
    subscribe({ branchId, listener }) {
      const state = stateFor(branchId)
      for (const signal of state.inFlight) listener(signal)
      state.listeners.add(listener)

      return () => {
        state.listeners.delete(listener)
        forgetIfIdle({ branchId, state })
      }
    },

    snapshot({ branchId }) {
      return branches.get(branchId)?.inFlight ?? NOTHING_IN_FLIGHT
    },

    publisherFor({ branchId, filter }) {
      return {
        branchId,

        onChunk(chunk) {
          const kept = filter === undefined ? chunk : filter(chunk)
          if (kept === null) return null

          const state = stateFor(branchId)
          const stepId = state.stepId ?? startStep({ branchId, state })
          publish({ state, signal: { type: 'chunk', stepId, chunk: kept } })
          return kept
        },

        settleAppend({ events }) {
          const state = branches.get(branchId)
          if (state === undefined) return

          const durable = durableAssistantEvent(events)
          const ended = endStep({ branchId, state, end: endOf(durable), supersededBy: refOf(durable) })
          if (!ended) notify({ state, signal: { type: 'events-appended' } })
        },

        close({ end }) {
          const state = branches.get(branchId)
          if (state === undefined) return

          if (needsAStepToFailIn({ state, end })) startStep({ branchId, state })
          endStep({ branchId, state, end, supersededBy: null })
        },
      }
    },
  }
}
