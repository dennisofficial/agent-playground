import { EStopAction, toThreadId, type EventDraft, type ThreadId } from '@dltech/atlas-core'
import {
  ServiceRegistryPort,
  type EKilledBy,
  type ServiceSnapshot,
  type ServiceStopOutcome,
  type StartedServiceOutcome,
} from '@dltech/atlas-harness'

export const FAKE_SERVICE_OWNER = toThreadId('opened-thread')

const NO_NOTICES: readonly ServiceSnapshot[] = Object.freeze([])

export type FakeServices = ServiceRegistryPort & {
  place: (snapshot: ServiceSnapshot, owner?: ThreadId) => void
  announce: (snapshot: ServiceSnapshot, owner?: ThreadId) => void
  readonly stopped: readonly { serviceId: string; by: EKilledBy }[]
}

type OwnedService = { snapshot: ServiceSnapshot; threadId: ThreadId }

export function fakeServiceRegistry(): FakeServices {
  const owned: OwnedService[] = []
  const stopped: { serviceId: string; by: EKilledBy }[] = []
  const listeners = new Set<() => void>()
  let ended: readonly OwnedService[] = []

  const settle = (next: readonly OwnedService[]): void => {
    ended = next
    for (const listener of [...listeners]) listener()
  }

  const noticedBy = new Map<ThreadId, readonly ServiceSnapshot[]>()
  const notices = (threadId: ThreadId): readonly ServiceSnapshot[] => {
    const mine = ended.filter((one) => one.threadId === threadId).map((one) => one.snapshot)
    if (mine.length === 0) {
      noticedBy.delete(threadId)
      return NO_NOTICES
    }

    const held = noticedBy.get(threadId)
    if (
      held !== undefined &&
      held.length === mine.length &&
      held.every((snapshot, at) => snapshot === mine[at])
    ) {
      return held
    }

    noticedBy.set(threadId, mine)
    return mine
  }

  const find = (serviceId: string): ServiceSnapshot | undefined =>
    owned.find((one) => one.snapshot.serviceId === serviceId)?.snapshot

  return {
    get stopped() {
      return stopped
    },

    place: (snapshot, owner = FAKE_SERVICE_OWNER) => {
      owned.push({ snapshot, threadId: owner })
    },

    announce: (snapshot, owner = FAKE_SERVICE_OWNER) => {
      owned.push({ snapshot, threadId: owner })
      settle([...ended, { snapshot, threadId: owner }])
    },

    start: (): Promise<StartedServiceOutcome> =>
      Promise.resolve({ ok: false, reason: 'the fake registry starts no processes' }),

    stop: ({ serviceId, by }): ServiceStopOutcome => {
      const snapshot = find(serviceId)
      if (snapshot === undefined) return { ok: false, reason: `no service ${serviceId}` }
      stopped.push({ serviceId, by })
      return { ok: true, snapshot, action: EStopAction.Term }
    },

    list: () => owned.map((one) => one.snapshot),

    threadsAwaitingNotice: () => [...new Set(ended.map((one) => one.threadId))],

    drainNotifications: ({ threadId }) => {
      const handed = ended.filter((one) => one.threadId === threadId)
      if (handed.length === 0) return []

      settle(ended.filter((one) => one.threadId !== threadId))
      return handed.map(({ snapshot }): EventDraft => ({
        type: 'service-ended',
        serviceId: snapshot.serviceId,
        command: snapshot.command,
        description: snapshot.description,
        status: snapshot.status,
        killedBy: snapshot.killedBy,
        exitCode: snapshot.exitCode,
        logPath: snapshot.logPath,
        tail: `tail of ${snapshot.serviceId}`,
      }))
    },

    pendingNotices: ({ threadId }) => notices(threadId),

    onNotice: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    forgetNotices: ({ threadId }) => {
      const kept = ended.filter((one) => one.threadId !== threadId)
      if (kept.length === ended.length) return
      settle(kept)
    },

    closeAll: async () => {},
  }
}
