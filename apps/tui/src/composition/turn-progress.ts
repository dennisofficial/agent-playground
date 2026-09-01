import type { Chunk } from '@dltech/atlas-core'
import {
  ETurnStatus,
  type ChannelSignal,
  type RetryWaitingSignal,
  type TurnOutcome,
} from '@dltech/atlas-harness'

import type { StepFailure, TranscriptModel } from '../store'
import { IDLE_TURN, type TurnClock } from '../ui/components/transcript'

const CHARACTERS_PER_TOKEN = 4

export type TurnProgress = { characters: number; clock: TurnClock }

export const IDLE_PROGRESS: TurnProgress = { characters: 0, clock: IDLE_TURN }

const tokensOf = (characters: number): number => Math.ceil(characters / CHARACTERS_PER_TOKEN)

const deltaTextOf = (chunk: Chunk): string => {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text
  return chunk.type === 'tool-input-delta' ? chunk.text : ''
}

function reasoningAfter(args: { chunk: Chunk; reasoning: boolean }): boolean {
  switch (args.chunk.type) {
    case 'reasoning-start':
    case 'reasoning-delta':
      return true
    case 'reasoning-end':
    case 'text-start':
    case 'text-delta':
    case 'tool-input-start':
    case 'tool-input-delta':
    case 'tool-call':
    case 'finish':
      return false
    default:
      return args.reasoning
  }
}

export const turnStarted = (args: { now: number }): TurnProgress => ({
  characters: 0,
  clock: {
    startedAt: args.now,
    outputTokens: 0,
    interrupting: false,
    reasoning: false,
    completed: null,
    retry: null,
  },
})

export const turnInterrupting = (progress: TurnProgress): TurnProgress =>
  progress.clock.startedAt === null
    ? progress
    : { ...progress, clock: { ...progress.clock, interrupting: true, retry: null } }

/**
 * A retry throws away the attempt that failed, so the characters counted from it are thrown away
 * too — otherwise the token estimate keeps the abandoned stream in it.
 */
const turnRetrying = (args: {
  progress: TurnProgress
  signal: RetryWaitingSignal
  now: number
}): TurnProgress => ({
  characters: 0,
  clock: {
    ...args.progress.clock,
    outputTokens: 0,
    reasoning: false,
    retry: {
      attempt: args.signal.attempt,
      maxAttempts: args.signal.maxAttempts,
      delayMs: args.signal.delayMs,
      reason: args.signal.reason,
      startedAt: args.now,
    },
  },
})

export function turnAdvanced(args: {
  progress: TurnProgress
  signal: ChannelSignal
  now: number
}): TurnProgress {
  if (args.signal.type === 'retry-waiting') {
    return turnRetrying({ progress: args.progress, signal: args.signal, now: args.now })
  }

  const { clock } = args.progress

  if (args.signal.type === 'step-started') {
    return clock.retry === null ? args.progress : { ...args.progress, clock: { ...clock, retry: null } }
  }

  if (args.signal.type !== 'chunk') return args.progress

  const reasoning = reasoningAfter({ chunk: args.signal.chunk, reasoning: clock.reasoning })
  const text = deltaTextOf(args.signal.chunk)
  const retry = null

  if (text.length === 0) {
    if (reasoning === clock.reasoning && clock.retry === null) return args.progress
    return { ...args.progress, clock: { ...clock, reasoning, retry } }
  }

  const characters = args.progress.characters + text.length
  return { characters, clock: { ...clock, outputTokens: tokensOf(characters), reasoning, retry } }
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
      reasoning: false,
      retry: null,
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
