import { EPullRequestLookup, type PullRequestReading } from './port'
import { EChecksState } from './pull-request'

export enum EPollDecision {
  Ask = 'ask',
  Hold = 'hold',
  Never = 'never',
}

export const POLL_FLOOR_MS = 10_000

export const POLL_RUNNING_MS = 30_000

export const POLL_SETTLED_MS = 5 * 60_000

export const POLL_BACKOFF_START_MS = 60_000

export const POLL_BACKOFF_CAP_MS = 15 * 60_000

const backoffMs = (consecutiveFailures: number): number => {
  const doubled = POLL_BACKOFF_START_MS * 2 ** Math.max(consecutiveFailures - 1, 0)
  return Math.min(doubled, POLL_BACKOFF_CAP_MS)
}

const intervalMs = (args: {
  reading: PullRequestReading
  consecutiveFailures: number
}): number | null => {
  const { reading } = args
  if (reading.lookup === EPullRequestLookup.Unavailable) {
    return reading.retryable ? backoffMs(args.consecutiveFailures) : null
  }
  if (reading.lookup === EPullRequestLookup.Absent) return POLL_SETTLED_MS

  return reading.pullRequest.checks === EChecksState.Running ? POLL_RUNNING_MS : POLL_SETTLED_MS
}

/**
 * `expectingUntil` is what a push buys. GitHub has no check to report in the seconds after one, so
 * the rollup comes back empty and the ordinary reading of it — settled, nothing running — is the
 * five-minute branch, exactly when the answer is about to change. Inside the window a reading that
 * came back cleanly is chased at the running cadence instead.
 *
 * It never overrides a failure: backoff exists because the far side is broken, and a push does not
 * mend it. The floor is checked first, so this makes polling eager rather than unbounded.
 */
export function pollDecision(args: {
  lastAskedAt: number | null
  lastReading: PullRequestReading | null
  consecutiveFailures: number
  now: number
  floorMs?: number
  expectingUntil?: number | null
}): EPollDecision {
  const floorMs = args.floorMs ?? POLL_FLOOR_MS
  const { lastAskedAt, lastReading } = args

  if (lastAskedAt !== null && args.now - lastAskedAt < floorMs) return EPollDecision.Hold
  if (lastReading === null || lastAskedAt === null) return EPollDecision.Ask

  const interval = intervalMs({
    reading: lastReading,
    consecutiveFailures: args.consecutiveFailures,
  })
  if (interval === null) return EPollDecision.Never

  const expecting =
    args.expectingUntil !== null &&
    args.expectingUntil !== undefined &&
    args.now < args.expectingUntil
  const answered = lastReading.lookup !== EPullRequestLookup.Unavailable
  const due = expecting && answered ? Math.min(interval, POLL_RUNNING_MS) : interval

  return args.now - lastAskedAt >= due ? EPollDecision.Ask : EPollDecision.Hold
}
