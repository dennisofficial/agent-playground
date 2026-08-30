import { NO_USAGE, type AccountId, type AccountUsage, type AccountUsagePort } from '@dltech/atlas-core'

export const USAGE_POLL_FLOOR_MS = 20_000

export const USAGE_POLL_LIVE_MS = 60_000

export type AccountUsageService = {
  snapshot: () => AccountUsage
  snapshotFor: (args: { accountId: AccountId }) => AccountUsage
  version: () => number
  subscribe: (listener: () => void) => () => void
  refresh: (args?: { accountId?: AccountId; force?: boolean }) => Promise<void>
  track: (args?: { accountId?: AccountId }) => void
  stopTracking: (args?: { accountId?: AccountId }) => void
  dispose: () => void
}

export function createAccountUsageService(args: {
  usage: AccountUsagePort
  now?: () => number
  liveIntervalMs?: number
  floorMs?: number
}): AccountUsageService {
  const now = args.now ?? Date.now
  const floorMs = args.floorMs ?? USAGE_POLL_FLOOR_MS
  const liveIntervalMs = args.liveIntervalMs ?? USAGE_POLL_LIVE_MS

  const WHICHEVER_ANSWERS = '\u0000active'

  const listeners = new Set<() => void>()
  const readings = new Map<string, AccountUsage>()
  const polledAt = new Map<string, number>()
  let version = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let disposed = false

  const publish = (args_: { key: string; usage: AccountUsage }): void => {
    readings.set(args_.key, args_.usage)
    version += 1
    for (const listener of listeners) listener()
  }

  const held = (args_: { key: string; force: boolean }): boolean => {
    if (args_.force) return false

    const last = polledAt.get(args_.key)
    return last !== undefined && now() - last < floorMs
  }

  const refresh = async (request?: { accountId?: AccountId; force?: boolean }): Promise<void> => {
    if (disposed) return

    const key = request?.accountId ?? WHICHEVER_ANSWERS
    if (held({ key, force: request?.force ?? false })) return

    polledAt.set(key, now())

    const usage = await args.usage.read(
      request?.accountId === undefined ? undefined : { accountId: request.accountId },
    )
    if (disposed || usage === null) return

    publish({ key, usage })
  }

  const untrack = (): void => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  return {
    snapshot: () => readings.get(WHICHEVER_ANSWERS) ?? NO_USAGE,
    snapshotFor: (request) => readings.get(request.accountId) ?? NO_USAGE,
    version: () => version,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    /** The five-hour window is burned by the turn in flight, so the meters follow it. */
    track: (request) => {
      untrack()
      void refresh(request)
      timer = setInterval(() => void refresh(request), liveIntervalMs)
      timer.unref?.()
    },
    /** The turn's last tokens land after it ends, so this is the reading worth keeping. */
    stopTracking: (request) => {
      untrack()
      void refresh({ ...request, force: true })
    },
    dispose: () => {
      disposed = true
      untrack()
      listeners.clear()
      readings.clear()
      polledAt.clear()
    },
  }
}
