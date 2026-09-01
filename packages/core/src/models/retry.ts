export enum ERetryReason {
  RateLimited = 'rate-limited',
  Overloaded = 'overloaded',
  ServerError = 'server-error',
  Network = 'network',
}

export type ModelFailure = {
  status?: number | undefined
  retryAfterMs?: number | undefined
}

export type RetryPolicy = {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 10,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
}

export type RetryDecision =
  | { retry: true; delayMs: number; reason: ERetryReason }
  | { retry: false }

const TOO_MANY_REQUESTS = 429

// Anthropic returns 529 "overloaded" rather than a 503 when its capacity is exhausted.
// https://docs.anthropic.com/en/api/errors
const OVERLOADED = 529

const FIRST_SERVER_ERROR = 500

const NOTHING_LEFT_TO_TRY: RetryDecision = { retry: false }

export function retryReasonOf(failure: ModelFailure): ERetryReason | null {
  const { status } = failure
  if (status === undefined) return ERetryReason.Network
  if (status === TOO_MANY_REQUESTS) return ERetryReason.RateLimited
  if (status === OVERLOADED) return ERetryReason.Overloaded
  if (status >= FIRST_SERVER_ERROR) return ERetryReason.ServerError
  return null
}

function backoffMs(args: { attempts: number; policy: RetryPolicy; jitter: number }): number {
  const exponential = args.policy.baseDelayMs * 2 ** (args.attempts - 1)
  const capped = Math.min(exponential, args.policy.maxDelayMs)
  const spread = capped / 2
  return Math.round(spread + spread * args.jitter)
}

export function planRetry(args: {
  failure: ModelFailure
  attempts: number
  policy: RetryPolicy
  jitter: number
}): RetryDecision {
  const reason = retryReasonOf(args.failure)
  if (reason === null) return NOTHING_LEFT_TO_TRY
  if (args.attempts >= args.policy.maxAttempts) return NOTHING_LEFT_TO_TRY

  const { retryAfterMs } = args.failure
  const delayMs =
    retryAfterMs === undefined
      ? backoffMs({ attempts: args.attempts, policy: args.policy, jitter: args.jitter })
      : Math.min(retryAfterMs, args.policy.maxDelayMs)

  return { retry: true, delayMs, reason }
}
