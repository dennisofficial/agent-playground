import { ERetryReason } from '@dltech/atlas-core'

export type RetryWait = {
  attempt: number
  maxAttempts: number
  delayMs: number
  reason: ERetryReason
  startedAt: number
}

const MS_PER_SECOND = 1_000

const REASON_LABEL: Record<ERetryReason, string> = {
  [ERetryReason.RateLimited]: 'Rate limited',
  [ERetryReason.Overloaded]: 'API overloaded',
  [ERetryReason.ServerError]: 'API error',
  [ERetryReason.Network]: 'Connection lost',
}

export function retryRemainingMs(args: { retry: RetryWait; now: number }): number {
  return Math.max(0, args.retry.delayMs - (args.now - args.retry.startedAt))
}

export function retryLabel(args: { retry: RetryWait; now: number }): string {
  const seconds = Math.ceil(retryRemainingMs(args) / MS_PER_SECOND)
  const countdown = seconds <= 0 ? 'Retrying now' : `Retrying in ${seconds}s`
  const attempt = `attempt ${args.retry.attempt}/${args.retry.maxAttempts}`

  return `${REASON_LABEL[args.retry.reason]} · ${countdown} · ${attempt}`
}
