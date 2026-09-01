import { describe, expect, it } from 'bun:test'

import { ERetryReason } from '@dltech/atlas-core'

import { retryLabel, retryRemainingMs, type RetryWait } from '../retry-countdown'

const waiting = (over: Partial<RetryWait> = {}): RetryWait => ({
  attempt: 1,
  maxAttempts: 10,
  delayMs: 4_000,
  reason: ERetryReason.ServerError,
  startedAt: 1_000,
  ...over,
})

describe('counting down to the next attempt', () => {
  it('has the whole delay left the moment it starts waiting', () => {
    expect(retryRemainingMs({ retry: waiting(), now: 1_000 })).toBe(4_000)
  })

  it('runs down as the clock moves', () => {
    expect(retryRemainingMs({ retry: waiting(), now: 2_500 })).toBe(2_500)
  })

  it('never runs past zero, however late the frame is', () => {
    expect(retryRemainingMs({ retry: waiting(), now: 99_000 })).toBe(0)
  })

  it('names what went wrong, the seconds left and which attempt is coming', () => {
    expect(retryLabel({ retry: waiting(), now: 1_000 })).toBe(
      'API error · Retrying in 4s · attempt 1/10',
    )
  })

  it('rounds a part second up, so the count never shows zero while it still waits', () => {
    expect(retryLabel({ retry: waiting(), now: 4_900 })).toBe(
      'API error · Retrying in 1s · attempt 1/10',
    )
  })

  it('says it is going again once the wait is spent', () => {
    expect(retryLabel({ retry: waiting(), now: 5_000 })).toBe(
      'API error · Retrying now · attempt 1/10',
    )
  })

  it('carries the attempt it is on', () => {
    expect(retryLabel({ retry: waiting({ attempt: 7 }), now: 1_000 })).toBe(
      'API error · Retrying in 4s · attempt 7/10',
    )
  })

  it('tells a rate limit apart from a server error', () => {
    expect(retryLabel({ retry: waiting({ reason: ERetryReason.RateLimited }), now: 1_000 })).toBe(
      'Rate limited · Retrying in 4s · attempt 1/10',
    )
  })

  it('says the capacity ran out rather than blaming the request', () => {
    expect(retryLabel({ retry: waiting({ reason: ERetryReason.Overloaded }), now: 1_000 })).toBe(
      'API overloaded · Retrying in 4s · attempt 1/10',
    )
  })

  it('names a dropped connection rather than an API fault', () => {
    expect(retryLabel({ retry: waiting({ reason: ERetryReason.Network }), now: 1_000 })).toBe(
      'Connection lost · Retrying in 4s · attempt 1/10',
    )
  })
})
