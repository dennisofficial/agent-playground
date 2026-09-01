import { EAgentStatus, toThreadId, type EventDraft, type ThreadId } from '@dltech/atlas-core'
import { AgentRegistryPort, type AgentSnapshot, type EKilledBy } from '@dltech/atlas-harness'

export const FAKE_AGENT_OWNER = toThreadId('opened-thread')

const NOTHING_LISTED: readonly AgentSnapshot[] = Object.freeze([])

export function fakeAgentSnapshot(args: {
  agentId: string
  spawnedBy?: ThreadId
  agentType?: string
  intent?: string
  status?: EAgentStatus
  turns?: number
  toolCalls?: number
  lastTool?: string
}): AgentSnapshot {
  return {
    agentId: toThreadId(args.agentId),
    spawnedBy: args.spawnedBy ?? FAKE_AGENT_OWNER,
    agentType: args.agentType ?? 'explore',
    intent: args.intent ?? '',
    status: args.status ?? EAgentStatus.Running,
    turns: args.turns ?? 0,
    toolCalls: args.toolCalls ?? 0,
    lastTool: args.lastTool,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: undefined,
  }
}

export type FakeAgents = AgentRegistryPort & {
  place: (snapshot: AgentSnapshot) => void
  end: (args: { agentId: string; status?: EAgentStatus }) => void
  progressed: (args: { agentId: string }) => void
  refuseSay: (reason: string | null) => void
  readonly stopped: readonly { agentId: string; by: EKilledBy }[]
  readonly said: readonly { agentId: ThreadId; threadId: ThreadId; text: string }[]
}

/**
 * A held roster and a change listener, exactly as the supervisor keeps them: the sidebar reads
 * these on every render, so a listing derived per call would spin React.
 */
export function fakeAgentRegistry(): FakeAgents {
  const stopped: { agentId: string; by: EKilledBy }[] = []
  const said: { agentId: ThreadId; threadId: ThreadId; text: string }[] = []
  const changeListeners = new Set<() => void>()
  const noticeListeners = new Set<() => void>()

  let children: readonly AgentSnapshot[] = NOTHING_LISTED
  let owned: ReadonlyMap<ThreadId, readonly AgentSnapshot[]> = new Map()
  let ended: readonly AgentSnapshot[] = NOTHING_LISTED
  let sayRefusal: string | null = null

  const settle = (next: readonly AgentSnapshot[]): void => {
    children = next

    const byOwner = new Map<ThreadId, AgentSnapshot[]>()
    for (const snapshot of next) {
      const held = byOwner.get(snapshot.spawnedBy)
      if (held === undefined) byOwner.set(snapshot.spawnedBy, [snapshot])
      else held.push(snapshot)
    }
    owned = byOwner

    for (const listener of [...changeListeners]) listener()
  }

  const announce = (next: readonly AgentSnapshot[]): void => {
    ended = next
    for (const listener of [...noticeListeners]) listener()
  }

  const noticed = new Map<ThreadId, readonly AgentSnapshot[]>()
  const pending = (threadId: ThreadId): readonly AgentSnapshot[] => {
    const mine = ended.filter((one) => one.spawnedBy === threadId)
    if (mine.length === 0) {
      noticed.delete(threadId)
      return NOTHING_LISTED
    }

    const held = noticed.get(threadId)
    if (
      held !== undefined &&
      held.length === mine.length &&
      held.every((snapshot, at) => snapshot === mine[at])
    ) {
      return held
    }

    noticed.set(threadId, mine)
    return mine
  }

  const refused = (agentId: string) => ({ ok: false as const, reason: `no sub-agent ${agentId}` })

  return {
    get stopped() {
      return stopped
    },

    get said() {
      return said
    },

    place: (snapshot) => settle([...children, snapshot]),

    progressed: ({ agentId }) => {
      const found = children.find((one) => one.agentId === agentId)
      if (found === undefined) return

      const stepped: AgentSnapshot = { ...found, toolCalls: found.toolCalls + 1 }
      settle(children.map((one) => (one.agentId === agentId ? stepped : one)))
    },

    end: ({ agentId, status = EAgentStatus.Finished }) => {
      const found = children.find((one) => one.agentId === agentId)
      if (found === undefined) return

      const done: AgentSnapshot = { ...found, status, endedAt: '2026-01-01T00:01:00.000Z' }
      settle(children.map((one) => (one.agentId === agentId ? done : one)))
      announce([...ended, done])
    },

    types: () => [],

    spawn: async () => refused('the fake registry spawns nothing'),

    refuseSay: (reason) => {
      sayRefusal = reason
    },

    say: async ({ agentId, threadId, text }) => {
      if (sayRefusal !== null) return { ok: false as const, reason: sayRefusal }

      said.push({ agentId, threadId, text })
      const found = children.find((one) => one.agentId === agentId)
      if (found === undefined) return refused(agentId)
      return { ok: true, snapshot: found }
    },

    resume: async ({ agentId }) => refused(agentId),

    stop: ({ agentId, by }) => {
      const found = children.find((one) => one.agentId === agentId)
      if (found === undefined) return refused(agentId)

      stopped.push({ agentId, by })
      const halted: AgentSnapshot = {
        ...found,
        status: EAgentStatus.Stopped,
        killedBy: by,
        endedAt: '2026-01-01T00:01:00.000Z',
      }
      settle(children.map((one) => (one.agentId === agentId ? halted : one)))
      announce([...ended, halted])

      return { ok: true, snapshot: halted }
    },

    list: ({ threadId }) => owned.get(threadId) ?? NOTHING_LISTED,

    recordLostAgents: async () => ({ settled: NOTHING_LISTED, unlogged: [] }),

    listEverywhere: () => children,

    drainNotifications: ({ threadId }) => {
      const handed = ended.filter((one) => one.spawnedBy === threadId)
      if (handed.length === 0) return []

      announce(ended.filter((one) => one.spawnedBy !== threadId))
      return handed.map(
        (snapshot): EventDraft => ({
          type: 'agent-ended',
          agentId: snapshot.agentId,
          agentType: snapshot.agentType,
          intent: snapshot.intent,
          status: snapshot.status,
          prose: `${snapshot.agentType} finished`,
          turns: snapshot.turns,
          toolCalls: snapshot.toolCalls,
          ...(snapshot.killedBy === undefined ? {} : { killedBy: snapshot.killedBy }),
        }),
      )
    },

    pendingNotices: ({ threadId }) => pending(threadId),

    threadsAwaitingNotice: () => [...new Set(ended.map((one) => one.spawnedBy))],

    onNotice: (listener) => {
      noticeListeners.add(listener)
      return () => void noticeListeners.delete(listener)
    },

    onChange: (listener) => {
      changeListeners.add(listener)
      return () => void changeListeners.delete(listener)
    },

    forgetNotices: ({ threadId }) => {
      const kept = ended.filter((one) => one.spawnedBy !== threadId)
      if (kept.length === ended.length) return
      announce(kept)
    },

    closeAll: async () => {},
  }
}
