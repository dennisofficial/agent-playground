import type { LinkedPullRequest } from '@dltech/atlas-core'

import {
  checkoutKey,
  EPollDecision,
  EPullRequestLookup,
  POLL_FLOOR_MS,
  pollDecision,
  type PullRequestPort,
  type PullRequestReading,
  type RepositoryCheckout,
} from './pure'
import { createPullRequestReadings } from './pull-request-readings'

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
  watch: (args: { links: readonly LinkedPullRequest[] }) => void
  current: () => { checkout: RepositoryCheckout; reading: PullRequestReading } | null
  expectChecks: () => void
  recheck: () => void
  refresh: (args: { checkout: RepositoryCheckout; force?: boolean }) => Promise<void>
  dispose: () => void
}

type PullTarget =
  | { kind: 'checkout'; checkout: RepositoryCheckout }
  | { kind: 'link'; link: LinkedPullRequest }

const CANNOT_ASK: PullRequestReading = {
  lookup: EPullRequestLookup.Unavailable,
  retryable: true,
}

const linkKey = (link: { repo: string; number: number }): string => `${link.repo}#${link.number}`

const keyOf = (target: PullTarget): string =>
  target.kind === 'checkout' ? checkoutKey(target.checkout) : linkKey(target.link)

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
  const inFlight = new Map<string, Promise<void>>()
  const watched = new Map<string, LinkedPullRequest>()

  let tracked: RepositoryCheckout | null = null
  let following = false
  let expectingUntil: number | null = null
  let version = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let disposed = false

  const notify = (): void => {
    version += 1
    for (const listener of listeners) listener()
  }

  const readings = createPullRequestReadings({ notify })

  /**
   * A port is allowed to reject — a pushing one loses its socket by throwing — and a rejection that
   * escaped here would leave the failure uncounted, so the backoff would never start and the tick
   * would ask again every floor.
   */
  const readingOf = async (target: PullTarget): Promise<PullRequestReading> => {
    try {
      return target.kind === 'checkout'
        ? await args.pullRequests.read({ checkout: target.checkout })
        : await args.pullRequests.readLinked({
            repo: target.link.repo,
            number: target.link.number,
          })
    } catch {
      return CANNOT_ASK
    }
  }

  const ask = async (request: { key: string; target: PullTarget }): Promise<void> => {
    readings.markAsked({ key: request.key, at: now() })
    try {
      const reading = await readingOf(request.target)
      if (disposed) return
      if (request.target.kind === 'link' && !watched.has(request.key)) return

      readings.record({ key: request.key, reading })
    } finally {
      inFlight.delete(request.key)
    }
  }

  const begin = (request: { key: string; target: PullTarget }): Promise<void> => {
    const asked = ask(request)
    inFlight.set(request.key, asked)
    return asked
  }

  const refreshTarget = async (request: {
    target: PullTarget
    force?: boolean
  }): Promise<void> => {
    if (disposed) return

    const key = keyOf(request.target)
    const running = inFlight.get(key)
    if (running !== undefined) return running

    const schedule = readings.scheduleOf({ key })
    const decision = pollDecision({
      lastAskedAt: schedule.lastAskedAt,
      lastReading: schedule.lastReading,
      consecutiveFailures: schedule.consecutiveFailures,
      now: now(),
      floorMs,
      expectingUntil,
    })
    if (decision === EPollDecision.Hold) return
    if (decision === EPollDecision.Never && request.force !== true) return

    return begin({ key, target: request.target })
  }

  const refresh = (request: {
    checkout: RepositoryCheckout
    force?: boolean
  }): Promise<void> =>
    refreshTarget({
      target: { kind: 'checkout', checkout: request.checkout },
      force: request.force === true,
    })

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

    const last = readings.scheduleOf({ key }).lastAskedAt
    if (last !== null && now() - last < floorMs) return

    return begin({ key, target: { kind: 'checkout', checkout } })
  }

  const untick = (): void => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  const tick = (): void => {
    if (following && tracked !== null) void refresh({ checkout: tracked })
    for (const link of watched.values()) {
      void refreshTarget({ target: { kind: 'link', link } })
    }
  }

  /**
   * One interval serves the tracked checkout and every watched link, so it lives while either
   * does — `stopTracking` alone cannot be what clears it. A pushing port arms nothing, as before.
   */
  const syncTimer = (): void => {
    untick()
    if (disposed || args.pullRequests.pushes) return
    if (!(following && tracked !== null) && watched.size === 0) return

    timer = setInterval(tick, tickMs)
    timer.unref?.()
  }

  return {
    snapshot: readings.snapshot,
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
      const key = checkoutKey(checkout)
      const previous = tracked === null ? null : checkoutKey(tracked)
      if (previous !== null && previous !== key) {
        readings.forget({ key: previous })
        notify()
      }
      tracked = checkout
      following = true

      void refresh({ checkout, force: true })
      syncTimer()
    },
    stopTracking: () => {
      tracked = null
      following = false
      syncTimer()
    },
    /**
     * The durable link set, mirrored: a key the set gains is asked at once, and a key it loses is
     * forgotten exactly as a hopped-away checkout is — mid-flight reads for it are dropped on
     * landing rather than resurrecting the key.
     */
    watch: ({ links }) => {
      if (disposed) return

      const next = new Map(links.map((link) => [linkKey(link), link]))
      let dropped = false
      for (const key of [...watched.keys()]) {
        if (next.has(key)) continue

        watched.delete(key)
        readings.forget({ key })
        dropped = true
      }
      for (const [key, link] of next) {
        if (watched.has(key)) continue

        watched.set(key, link)
        void refreshTarget({ target: { kind: 'link', link }, force: true })
      }
      if (dropped) notify()
      syncTimer()
    },
    current: () => {
      if (tracked === null) return null

      return { checkout: tracked, reading: readings.snapshot({ key: checkoutKey(tracked) }) }
    },
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
      tracked = null
      following = false
      watched.clear()
      untick()
      listeners.clear()
      readings.clear()
      inFlight.clear()
    },
  }
}
