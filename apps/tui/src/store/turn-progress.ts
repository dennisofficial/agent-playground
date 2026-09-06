import type { Chunk } from '@dltech/atlas-core'
import type { ChannelSignal, RetryWaitingSignal } from '@dltech/atlas-harness'

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
  const outputTokens = tokensOf(characters)

  if (outputTokens === clock.outputTokens && reasoning === clock.reasoning && clock.retry === null) {
    return { characters, clock }
  }

  return { characters, clock: { ...clock, outputTokens, reasoning, retry } }
}

/**
 * A turn advanced by a signal, opening the clock if nothing had opened it yet.
 *
 * The distinction is who started the turn. A turn this session drove is stamped at the keystroke,
 * so its clock is already running by the time the first signal lands and this changes nothing. A
 * turn somebody else drove — a sub-agent's, stepped by the supervisor — has no keystroke to stamp
 * against, and `step-started` is the earliest honest reading of when it began.
 */
export function turnObserved(args: {
  progress: TurnProgress
  signal: ChannelSignal
  now: number
}): TurnProgress {
  const opened =
    args.signal.type === 'step-started' && args.progress.clock.startedAt === null
      ? turnStarted({ now: args.now })
      : args.progress

  return turnAdvanced({ progress: opened, signal: args.signal, now: args.now })
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
