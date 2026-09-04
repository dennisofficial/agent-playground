import {
  EPullRequestLookup,
  NO_PULL_REQUEST_READING,
  samePullRequestReading,
  type PullRequestReading,
} from './pure'

export type ReadingSchedule = {
  lastAskedAt: number | null
  lastReading: PullRequestReading | null
  consecutiveFailures: number
}

export type PullRequestReadings = {
  snapshot: (args: { key: string }) => PullRequestReading
  scheduleOf: (args: { key: string }) => ReadingSchedule
  markAsked: (args: { key: string; at: number }) => void
  record: (args: { key: string; reading: PullRequestReading }) => void
  forget: (args: { key: string }) => void
  clear: () => void
}

/**
 * The per-key memory of the pull request poller. `shown` is deliberately not `answers`: a reading
 * we could not take must not blank a pill that was right a minute ago, so the schedule remembers
 * the failure while the screen keeps the last pull request it actually saw.
 */
export function createPullRequestReadings(args: { notify: () => void }): PullRequestReadings {
  const answers = new Map<string, PullRequestReading>()
  const shown = new Map<string, PullRequestReading>()
  const askedAt = new Map<string, number>()
  const failures = new Map<string, number>()

  return {
    snapshot: ({ key }) => shown.get(key) ?? NO_PULL_REQUEST_READING,
    scheduleOf: ({ key }) => ({
      lastAskedAt: askedAt.get(key) ?? null,
      lastReading: answers.get(key) ?? null,
      consecutiveFailures: failures.get(key) ?? 0,
    }),
    markAsked: ({ key, at }) => {
      askedAt.set(key, at)
    },
    record: ({ key, reading }) => {
      answers.set(key, reading)

      const unavailable = reading.lookup === EPullRequestLookup.Unavailable
      failures.set(key, unavailable && reading.retryable ? (failures.get(key) ?? 0) + 1 : 0)

      const previous = shown.get(key)
      const next =
        unavailable && previous !== undefined && previous.lookup === EPullRequestLookup.Found
          ? previous
          : reading
      if (previous !== undefined && samePullRequestReading(previous, next)) return

      shown.set(key, next)
      args.notify()
    },
    forget: ({ key }) => {
      answers.delete(key)
      shown.delete(key)
      askedAt.delete(key)
      failures.delete(key)
    },
    clear: () => {
      answers.clear()
      shown.clear()
      askedAt.clear()
      failures.clear()
    },
  }
}
