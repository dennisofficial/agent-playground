import type { RetryWait } from './retry-countdown'

export type TurnClock = {
  startedAt: number | null
  outputTokens: number
  interrupting: boolean
  reasoning: boolean
  completed: { durationMs: number; outputTokens: number } | null
  retry: RetryWait | null
}

export const IDLE_TURN: TurnClock = {
  startedAt: null,
  outputTokens: 0,
  interrupting: false,
  reasoning: false,
  completed: null,
  retry: null,
}
