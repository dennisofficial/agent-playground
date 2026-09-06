import { ETurnStatus, type TurnOutcome } from '@dltech/atlas-harness'

import type { StepFailure, TranscriptModel } from '../store'
import { IDLE_TURN, type TurnClock } from '../ui/turn-clock'

export {
  IDLE_PROGRESS,
  turnAdvanced,
  turnInterrupting,
  turnObserved,
  turnSettled,
  turnStarted,
  type TurnProgress,
} from '../store/turn-progress'

/**
 * A child's clock, whose elapsed is the step's rather than the fold's.
 *
 * The supervisor stamps `steppingSince` when it hands a child a step, so the reading is held outside
 * the view and survives being closed and reopened — a clock kept in the component would restart from
 * whenever the operator happened to walk in, and a child between two steps would show none at all.
 */
export function turnOfChild(args: {
  observed: TurnClock
  running: boolean
  steppingSince: string | null
}): TurnClock {
  if (!args.running) return IDLE_TURN

  const parsed = args.steppingSince === null ? Number.NaN : Date.parse(args.steppingSince)
  const startedAt = Number.isNaN(parsed) ? args.observed.startedAt : parsed

  return startedAt === args.observed.startedAt ? args.observed : { ...args.observed, startedAt }
}

// OpenTUI paints frames on its own loop, so one lands between a React state update and the effect
// that would have caught the clock up — leaving `now` behind `startedAt` for a frame.
export const clockReadableAt = (args: { now: number; clock: TurnClock }): number =>
  args.clock.startedAt === null ? args.now : Math.max(args.now, args.clock.startedAt)

const SUSPENSION_FLOOR_MS = 10_000

export type Suspension = { tickedAt: number; suspendedMs: number }

export const suspensionFrom = (args: { now: number; suspendedMs?: number }): Suspension => ({
  tickedAt: args.now,
  suspendedMs: args.suspendedMs ?? 0,
})

export function suspensionTicked(args: {
  suspension: Suspension
  now: number
  intervalMs: number
}): Suspension {
  const unticked = args.now - args.suspension.tickedAt - args.intervalMs
  if (unticked < SUSPENSION_FLOOR_MS) return { ...args.suspension, tickedAt: args.now }

  return { tickedAt: args.now, suspendedMs: args.suspension.suspendedMs + unticked }
}

export const awakeAt = (args: { suspension: Suspension; now: number }): number =>
  args.now - args.suspension.suspendedMs

export function stoppageOf(outcome: TurnOutcome): string | null {
  if (outcome.status === ETurnStatus.Failed) return outcome.message
  if (outcome.status === ETurnStatus.Paused) return `The turn is waiting: ${outcome.reason}.`
  return null
}

const failureNaming = (args: {
  reported: StepFailure | null
  said: string | null
}): StepFailure | null => {
  if (typeof args.reported?.message === 'string') return args.reported
  if (args.said !== null) return { message: args.said }
  return args.reported
}

export function transcriptOfTurn(args: {
  model: TranscriptModel
  working: boolean
  failure: string | null
}): TranscriptModel {
  const streaming = args.model.streaming || args.working
  const failure = failureNaming({ reported: args.model.failure, said: args.failure })

  if (streaming === args.model.streaming && failure === args.model.failure) return args.model
  return { ...args.model, streaming, failure }
}
