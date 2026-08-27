import type { Chunk } from '@dltech/atlas-core'
import { ETurnStatus, type ChannelSignal, type TurnOutcome } from '@dltech/atlas-harness'

import type { StepFailure, TranscriptModel } from '../store'
import { IDLE_TURN, type TurnClock } from '../ui/components/transcript'

const CHARACTERS_PER_TOKEN = 4

export type TurnProgress = { characters: number; clock: TurnClock }

export const IDLE_PROGRESS: TurnProgress = { characters: 0, clock: IDLE_TURN }

const tokensOf = (characters: number): number => Math.ceil(characters / CHARACTERS_PER_TOKEN)

const deltaTextOf = (chunk: Chunk): string =>
  chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ? chunk.text : ''

export const turnStarted = (args: { now: number }): TurnProgress => ({
  characters: 0,
  clock: { startedAt: args.now, outputTokens: 0, interrupting: false, completed: null },
})

export const turnInterrupting = (progress: TurnProgress): TurnProgress =>
  progress.clock.startedAt === null
    ? progress
    : { ...progress, clock: { ...progress.clock, interrupting: true } }

export function turnAdvanced(args: {
  progress: TurnProgress
  signal: ChannelSignal
}): TurnProgress {
  if (args.signal.type !== 'chunk') return args.progress

  const text = deltaTextOf(args.signal.chunk)
  if (text.length === 0) return args.progress

  const characters = args.progress.characters + text.length
  return { characters, clock: { ...args.progress.clock, outputTokens: tokensOf(characters) } }
}

export function turnSettled(args: { progress: TurnProgress; now: number }): TurnProgress {
  const { startedAt, outputTokens } = args.progress.clock
  if (startedAt === null) return IDLE_PROGRESS

  return {
    characters: 0,
    clock: {
      startedAt: null,
      outputTokens: 0,
      interrupting: false,
      completed: { durationMs: Math.max(0, args.now - startedAt), outputTokens },
    },
  }
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
