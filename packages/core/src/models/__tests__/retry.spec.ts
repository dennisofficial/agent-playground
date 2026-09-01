import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_RETRY_POLICY,
  ERetryReason,
  planRetry,
  retryReasonOf,
  type RetryPolicy,
} from '../retry'

const POLICY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 30_000 }

const NO_JITTER = 1

describe('naming why a model call is worth trying again', () => {
  it('reads a rate limit off the status', () => {
    expect(retryReasonOf({ status: 429 })).toBe(ERetryReason.RateLimited)
  })

  it('reads the overloaded status Anthropic returns under load', () => {
    expect(retryReasonOf({ status: 529 })).toBe(ERetryReason.Overloaded)
  })

  it.each([500, 502, 503, 504])('reads %i as a server fault', (status) => {
    expect(retryReasonOf({ status })).toBe(ERetryReason.ServerError)
  })

  it('reads a failure with no status at all as a dropped connection', () => {
    expect(retryReasonOf({})).toBe(ERetryReason.Network)
  })

  it.each([400, 401, 403, 404, 413, 422])('refuses to retry %i, which will fail again', (status) => {
    expect(retryReasonOf({ status })).toBeNull()
  })
})

describe('planning the wait before trying again', () => {
  it('does not retry a failure that is the caller s fault', () => {
    const decision = planRetry({ failure: { status: 401 }, attempts: 1, policy: POLICY, jitter: NO_JITTER })

    expect(decision.retry).toBe(false)
  })

  it('backs off exponentially from the base delay', () => {
    const delays = [1, 2, 3, 4].map((attempts) => {
      const decision = planRetry({ failure: { status: 529 }, attempts, policy: POLICY, jitter: NO_JITTER })
      return decision.retry ? decision.delayMs : null
    })

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000])
  })

  it('never waits longer than the ceiling, however far the backoff has doubled', () => {
    const patient: RetryPolicy = { ...POLICY, maxAttempts: 30 }

    const decision = planRetry({ failure: { status: 529 }, attempts: 20, policy: patient, jitter: NO_JITTER })

    expect(decision.retry && decision.delayMs).toBe(patient.maxDelayMs)
  })

  it('stops once the attempts are spent', () => {
    const decision = planRetry({
      failure: { status: 529 },
      attempts: POLICY.maxAttempts,
      policy: POLICY,
      jitter: NO_JITTER,
    })

    expect(decision.retry).toBe(false)
  })

  it('still has one retry left on the attempt before the last', () => {
    const decision = planRetry({
      failure: { status: 529 },
      attempts: POLICY.maxAttempts - 1,
      policy: POLICY,
      jitter: NO_JITTER,
    })

    expect(decision.retry).toBe(true)
  })

  /**
   * Equal jitter: half the backoff is fixed and half is spread, so two clients that failed together
   * do not come back together, and no wait ever collapses to zero.
   */
  it('spreads the wait over the top half of the window', () => {
    const floor = planRetry({ failure: { status: 529 }, attempts: 3, policy: POLICY, jitter: 0 })
    const ceiling = planRetry({ failure: { status: 529 }, attempts: 3, policy: POLICY, jitter: 1 })

    expect(floor.retry && floor.delayMs).toBe(2_000)
    expect(ceiling.retry && ceiling.delayMs).toBe(4_000)
  })

  it('carries the reason so the operator is told what is being waited on', () => {
    const decision = planRetry({ failure: { status: 429 }, attempts: 1, policy: POLICY, jitter: NO_JITTER })

    expect(decision.retry && decision.reason).toBe(ERetryReason.RateLimited)
  })

  it('obeys a retry-after the server sent rather than its own backoff', () => {
    const decision = planRetry({
      failure: { status: 429, retryAfterMs: 12_000 },
      attempts: 1,
      policy: POLICY,
      jitter: 0,
    })

    expect(decision.retry && decision.delayMs).toBe(12_000)
  })

  it('clamps an absurd retry-after to the ceiling rather than hanging the turn', () => {
    const decision = planRetry({
      failure: { status: 429, retryAfterMs: 10 * 60 * 1_000 },
      attempts: 1,
      policy: POLICY,
      jitter: 0,
    })

    expect(decision.retry && decision.delayMs).toBe(POLICY.maxDelayMs)
  })

  it('ships a default policy that gives up rather than retrying forever', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(1)
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeLessThanOrEqual(10)
    expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBeGreaterThan(0)
  })
})
