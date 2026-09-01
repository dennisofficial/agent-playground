import {
  checkoutKey,
  EPollDecision,
  EPullRequestLookup,
  NO_PULL_REQUEST_READING,
  POLL_FLOOR_MS,
  pollDecision,
  type PullRequestPort,
  type PullRequestReading,
  type RepositoryCheckout,
} from './pure'

export const PULL_REQUEST_TICK_MS = 5_000

/**
 * How long after a push the schedule stays eager. GitHub usually registers a check run within
 * seconds, so this is sized for a congested Actions queue rather than the common case, and it costs
 * at most the window divided by the running cadence — six reads — because inside it the schedule
 * asks at exactly the rate running checks already earn.
 */
export const EXPECTING_CHECKS_MS = 3 * 60_000

export type PullRequestService = {
  snapshot: (args: { key: string }) => PullRequestReading
  version: () => number
  subscribe: (listener: () => void) => () => void
  track: (args: { checkout: RepositoryCheckout }) => void
  stopTracking: () => void
  expectChecks: () => void
  recheck: () => void
  refresh: (args: { checkout: RepositoryCheckout; force?: boolean }) => Promise<void>
  dispose: () => void
}

const sameReading = (left: PullRequestReading, right: PullRequestReading): boolean => {
  if (left.lookup !== EPullRequestLookup.Found || right.lookup !== EPullRequestLookup.Found) {
    return left.lookup === right.lookup
  }

  return (
    left.pullRequest.number === right.pullRequest.number &&
    left.pullRequest.state === right.pullRequest.state &&
    left.pullRequest.checks === right.pullRequest.checks &&
    left.pullRequest.title === right.pullRequest.title &&
    left.pullRequest.url === right.pullRequest.url &&
    left.pullRequest.tally.running === right.pullRequest.tally.running &&
    left.pullRequest.tally.passed === right.pullRequest.tally.passed &&
    left.pullRequest.tally.failed === right.pullRequest.tally.failed
  )
}

const CANNOT_ASK: PullRequestReading = {
  lookup: EPullRequestLookup.Unavailable,
  retryable: true,
}

export function createPullRequestService(args: {
  pullRequests: PullRequestPort
  now?: () => number
  tickMs?: number
  floorMs?: number
  expectingMs?: number
}): PullRequestService {
  const now = args.now ?? Date.now
  const floorMs = args.floorMs ?? POLL_FLOOR_MS
  const tickMs = args.tickMs ?? PULL_REQUEST_TICK_MS
  const expectingMs = args.expectingMs ?? EXPECTING_CHECKS_MS

  const listeners = new Set<() => void>()
  const answers = new Map<string, PullRequestReading>()
  const shown = new Map<string, PullRequestReading>()
  const askedAt = new Map<string, number>()
  const failures = new Map<string, number>()
  const inFlight = new Map<string, Promise<void>>()

  let tracked: RepositoryCheckout | null = null
  let expectingUntil: number | null = null
  let version = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let disposed = false

  const notify = (): void => {
    version += 1
    for (const listener of listeners) listener()
  }

  const forget = (key: string): void => {
    answers.delete(key)
    shown.delete(key)
    askedAt.delete(key)
    failures.delete(key)
  }

  /**
   * A reading we could not take must not blank a pill that was right a minute ago, so the schedule
   * remembers the failure while the screen keeps the last pull request it actually saw.
   */
  const record = (request: { key: string; reading: PullRequestReading }): void => {
    const { key, reading } = request
    answers.set(key, reading)

    const unavailable = reading.lookup === EPullRequestLookup.Unavailable
    failures.set(key, unavailable && reading.retryable ? (failures.get(key) ?? 0) + 1 : 0)

    const previous = shown.get(key)
    const next =
      unavailable && previous !== undefined && previous.lookup === EPullRequestLookup.Found
        ? previous
        : reading
    if (previous !== undefined && sameReading(previous, next)) return

    shown.set(key, next)
    notify()
  }

  /**
   * A port is allowed to reject — a pushing one loses its socket by throwing — and a rejection that
   * escaped here would leave the failure uncounted, so the backoff would never start and the tick
   * would ask again every floor.
   */
  const readingOf = async (checkout: RepositoryCheckout): Promise<PullRequestReading> => {
    try {
      return await args.pullRequests.read({ checkout })
    } catch {
      return CANNOT_ASK
    }
  }

  const ask = async (request: { key: string; checkout: RepositoryCheckout }): Promise<void> => {
    askedAt.set(request.key, now())
    try {
      const reading = await readingOf(request.checkout)
      if (disposed) return

      record({ key: request.key, reading })
    } finally {
      inFlight.delete(request.key)
    }
  }

  const heldByFloor = (key: string): boolean => {
    const last = askedAt.get(key)
    return last !== undefined && now() - last < floorMs
  }

  const begin = (request: { key: string; checkout: RepositoryCheckout }): Promise<void> => {
    const asked = ask(request)
    inFlight.set(request.key, asked)
    return asked
  }

  const refresh = async (request: {
    checkout: RepositoryCheckout
    force?: boolean
  }): Promise<void> => {
    if (disposed) return

    const key = checkoutKey(request.checkout)
    const running = inFlight.get(key)
    if (running !== undefined) return running

    const decision = pollDecision({
      lastAskedAt: askedAt.get(key) ?? null,
      lastReading: answers.get(key) ?? null,
      consecutiveFailures: failures.get(key) ?? 0,
      now: now(),
      floorMs,
      expectingUntil,
    })
    if (decision === EPollDecision.Hold) return
    if (decision === EPollDecision.Never && request.force !== true) return

    return begin({ key, checkout: request.checkout })
  }

  /**
   * The schedule has nothing useful to say about a key whose answer we have just been told changed,
   * so this consults the floor and nothing else. `force` on `refresh` is a different request — it
   * means "a trigger rather than the timer", and it deliberately leaves the cadence in charge so a
   * turn ending does not buy a read every ten seconds.
   */
  const askNow = async (checkout: RepositoryCheckout): Promise<void> => {
    const key = checkoutKey(checkout)
    const running = inFlight.get(key)
    if (running !== undefined) return running
    if (heldByFloor(key)) return

    return begin({ key, checkout })
  }

  const untrack = (): void => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  return {
    snapshot: ({ key }) => shown.get(key) ?? NO_PULL_REQUEST_READING,
    version: () => version,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    /**
     * The previous key goes in the same tick as the new one arrives, so a worktree hop or a thread
     * swap cannot leave the last branch's pull request on the footer for a poll interval.
     */
    track: ({ checkout }) => {
      untrack()
      const key = checkoutKey(checkout)
      const previous = tracked === null ? null : checkoutKey(tracked)
      if (previous !== null && previous !== key) {
        forget(previous)
        notify()
      }
      tracked = checkout

      void refresh({ checkout, force: true })
      if (args.pullRequests.pushes) return

      timer = setInterval(() => void refresh({ checkout }), tickMs)
      timer.unref?.()
    },
    stopTracking: untrack,
    /**
     * No argument, because the caller cannot honestly name one: the after-tool phase carries the
     * call and its result and no project directory, so the only checkout a push can be about is the
     * one the session is following. A push in some other directory costs the tracked key a few
     * reads and nothing else.
     */
    expectChecks: () => {
      if (disposed) return

      expectingUntil = now() + expectingMs
      if (tracked === null) return

      void askNow(tracked)
    },
    /**
     * One read and no window. After something that has already settled the pull request there is
     * nothing pending to chase, so staying eager for three minutes would poll a merged branch that
     * the settled cadence would otherwise have quieted.
     */
    recheck: () => {
      if (disposed || tracked === null) return

      void askNow(tracked)
    },
    dispose: () => {
      disposed = true
      expectingUntil = null
      untrack()
      listeners.clear()
      answers.clear()
      shown.clear()
      askedAt.clear()
      failures.clear()
      inFlight.clear()
    },
  }
}
