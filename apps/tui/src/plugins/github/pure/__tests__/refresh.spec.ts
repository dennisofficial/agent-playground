import { describe, expect, it } from 'bun:test'

import { EPullRequestLookup, type PullRequestReading } from '../port'
import { EChecksState, EPullRequestState, NO_CHECKS, type PullRequest } from '../pull-request'
import {
  EPollDecision,
  POLL_BACKOFF_CAP_MS,
  POLL_FLOOR_MS,
  POLL_RUNNING_MS,
  POLL_SETTLED_MS,
  pollDecision,
} from '../refresh'

const NOW = 1_000_000

const found = (checks: EChecksState): PullRequestReading => {
  const pullRequest: PullRequest = {
    number: 7,
    title: 'a change',
    url: 'https://github.com/o/r/pull/7',
    state: EPullRequestState.Open,
    checks,
    tally: NO_CHECKS,
  }
  return { lookup: EPullRequestLookup.Found, pullRequest }
}

const ABSENT: PullRequestReading = { lookup: EPullRequestLookup.Absent }

const unavailable = (retryable: boolean): PullRequestReading => ({
  lookup: EPullRequestLookup.Unavailable,
  retryable,
})

const decide = (args: {
  lastAskedAt: number | null
  lastReading: PullRequestReading | null
  consecutiveFailures?: number
  now: number
  expectingUntil?: number | null
}): EPollDecision =>
  pollDecision({
    lastAskedAt: args.lastAskedAt,
    lastReading: args.lastReading,
    consecutiveFailures: args.consecutiveFailures ?? 0,
    now: args.now,
    ...(args.expectingUntil === undefined ? {} : { expectingUntil: args.expectingUntil }),
  })

describe('pollDecision', () => {
  it('asks for a key it has never asked about', () => {
    expect(decide({ lastAskedAt: null, lastReading: null, now: NOW })).toBe(EPollDecision.Ask)
  })

  it('holds a second ask inside the floor however good the reason', () => {
    expect(
      decide({ lastAskedAt: NOW, lastReading: found(EChecksState.Running), now: NOW + 9_999 }),
    ).toBe(EPollDecision.Hold)
    expect(decide({ lastAskedAt: NOW, lastReading: null, now: NOW + POLL_FLOOR_MS - 1 })).toBe(
      EPollDecision.Hold,
    )
  })

  it('asks again after thirty seconds while checks are running, and not at twenty-nine', () => {
    const lastReading = found(EChecksState.Running)

    expect(decide({ lastAskedAt: NOW, lastReading, now: NOW + 29_000 })).toBe(EPollDecision.Hold)
    expect(decide({ lastAskedAt: NOW, lastReading, now: NOW + POLL_RUNNING_MS })).toBe(
      EPollDecision.Ask,
    )
  })

  it('waits five minutes once the checks have settled', () => {
    const lastReading = found(EChecksState.Passing)

    expect(decide({ lastAskedAt: NOW, lastReading, now: NOW + POLL_RUNNING_MS })).toBe(
      EPollDecision.Hold,
    )
    expect(decide({ lastAskedAt: NOW, lastReading, now: NOW + POLL_SETTLED_MS })).toBe(
      EPollDecision.Ask,
    )
  })

  it('waits five minutes on an absent pull request, which a browser can still open', () => {
    expect(decide({ lastAskedAt: NOW, lastReading: ABSENT, now: NOW + POLL_SETTLED_MS - 1 })).toBe(
      EPollDecision.Hold,
    )
    expect(decide({ lastAskedAt: NOW, lastReading: ABSENT, now: NOW + POLL_SETTLED_MS })).toBe(
      EPollDecision.Ask,
    )
  })

  it('doubles the backoff on each consecutive failure', () => {
    const lastReading = unavailable(true)
    const due = (consecutiveFailures: number, after: number): EPollDecision =>
      decide({ lastAskedAt: NOW, lastReading, consecutiveFailures, now: NOW + after })

    expect(due(1, 59_999)).toBe(EPollDecision.Hold)
    expect(due(1, 60_000)).toBe(EPollDecision.Ask)
    expect(due(2, 60_000)).toBe(EPollDecision.Hold)
    expect(due(2, 120_000)).toBe(EPollDecision.Ask)
    expect(due(4, 480_000)).toBe(EPollDecision.Ask)
  })

  it('caps the backoff at fifteen minutes', () => {
    const lastReading = unavailable(true)

    expect(
      decide({
        lastAskedAt: NOW,
        lastReading,
        consecutiveFailures: 20,
        now: NOW + POLL_BACKOFF_CAP_MS,
      }),
    ).toBe(EPollDecision.Ask)
    expect(
      decide({
        lastAskedAt: NOW,
        lastReading,
        consecutiveFailures: 20,
        now: NOW + POLL_BACKOFF_CAP_MS - 1,
      }),
    ).toBe(EPollDecision.Hold)
  })

  it('never asks again on its own once the failure is not retryable', () => {
    expect(
      decide({ lastAskedAt: NOW, lastReading: unavailable(false), now: NOW + POLL_BACKOFF_CAP_MS }),
    ).toBe(EPollDecision.Never)
  })
})

describe('pollDecision while checks are expected', () => {
  const EXPECTING_UNTIL = NOW + 180_000

  /**
   * The state a push leaves behind: a pull request whose rollup is still empty, which reads as
   * settled and would otherwise not be asked about again for five minutes.
   */
  const JUST_PUSHED = found(EChecksState.None)

  it('chases an empty rollup at the running cadence instead of the settled one', () => {
    expect(
      decide({
        lastAskedAt: NOW,
        lastReading: JUST_PUSHED,
        now: NOW + POLL_RUNNING_MS,
        expectingUntil: EXPECTING_UNTIL,
      }),
    ).toBe(EPollDecision.Ask)
    expect(decide({ lastAskedAt: NOW, lastReading: JUST_PUSHED, now: NOW + POLL_RUNNING_MS })).toBe(
      EPollDecision.Hold,
    )
  })

  it('chases a pull request that has not appeared yet', () => {
    expect(
      decide({
        lastAskedAt: NOW,
        lastReading: ABSENT,
        now: NOW + POLL_RUNNING_MS,
        expectingUntil: EXPECTING_UNTIL,
      }),
    ).toBe(EPollDecision.Ask)
  })

  it('still holds inside the floor, so eager is not unbounded', () => {
    expect(
      decide({
        lastAskedAt: NOW,
        lastReading: JUST_PUSHED,
        now: NOW + POLL_FLOOR_MS - 1,
        expectingUntil: EXPECTING_UNTIL,
      }),
    ).toBe(EPollDecision.Hold)
  })

  it('goes back to the settled cadence once the window has passed', () => {
    expect(
      decide({
        lastAskedAt: EXPECTING_UNTIL,
        lastReading: JUST_PUSHED,
        now: EXPECTING_UNTIL + POLL_RUNNING_MS,
        expectingUntil: EXPECTING_UNTIL,
      }),
    ).toBe(EPollDecision.Hold)
  })

  it('never shortens a backoff, which a push does nothing to mend', () => {
    expect(
      decide({
        lastAskedAt: NOW,
        lastReading: unavailable(true),
        consecutiveFailures: 3,
        now: NOW + POLL_RUNNING_MS,
        expectingUntil: EXPECTING_UNTIL,
      }),
    ).toBe(EPollDecision.Hold)
  })

  it('never revives a failure that will not come back on a timer', () => {
    expect(
      decide({
        lastAskedAt: NOW,
        lastReading: unavailable(false),
        now: NOW + POLL_RUNNING_MS,
        expectingUntil: EXPECTING_UNTIL,
      }),
    ).toBe(EPollDecision.Never)
  })

  it('leaves running checks exactly as they were', () => {
    expect(
      decide({
        lastAskedAt: NOW,
        lastReading: found(EChecksState.Running),
        now: NOW + POLL_RUNNING_MS,
        expectingUntil: EXPECTING_UNTIL,
      }),
    ).toBe(EPollDecision.Ask)
  })
})
