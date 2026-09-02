import {
  stampEvent,
  toThreadId,
  ECompactionAnchor,
  toCallId,
  toEventId,
  toRunId,
  type IdPort,
  type ThreadId,
  type Event,
  type EventLogPort,
} from '@dltech/atlas-core'
import type {
  SupervisedAgent,
  ThreadModel,
  ThreadStorePort,
  ThreadSummary,
  TurnLedgerPort,
  TurnSpend,
} from '@dltech/atlas-harness'

const AT = '2026-08-25T00:00:00.000Z'

export function fakeIds(): IdPort {
  let handed = 0

  return {
    nextThreadId: () => toThreadId(`handed-${(handed += 1)}`),
    nextRunId: () => toRunId(`run-${(handed += 1)}`),
    nextEventId: () => toEventId(`event-${(handed += 1)}`),
    nextCallId: () => toCallId(`call-${(handed += 1)}`),
  }
}

export const FAKE_WORKSPACE = '/work'

export type FakeThreadStore = ThreadStorePort & {
  readonly created: number
  readonly createdWith: readonly {
    workspace: string | null
    repo: string | null
    agent?: SupervisedAgent
  }[]
  readonly renames: readonly { threadId: ThreadId; title: string }[]
  readonly chosenModels: readonly { threadId: ThreadId; model: ThreadModel }[]
}

export function fakeThreadStore(
  args: {
    existing?: readonly ThreadId[]
    log?: FakeEventLog
    workspace?: string | null
    titles?: Readonly<Record<string, string>>
  } = {},
): FakeThreadStore {
  const workspaceOf = args.workspace === undefined ? FAKE_WORKSPACE : args.workspace
  const rows: ThreadSummary[] = (args.existing ?? []).map((id) => ({
    id,
    head: 0,
    createdAt: AT,
    updatedAt: AT,
    workspace: workspaceOf,
    repo: null,
    ...(args.titles?.[id] === undefined ? {} : { title: args.titles[id] }),
  }))

  let created = 0
  const createdWith: {
    workspace: string | null
    repo: string | null
    agent?: SupervisedAgent
  }[] = []
  const renames: { threadId: ThreadId; title: string }[] = []
  const chosenModels: { threadId: ThreadId; model: ThreadModel }[] = []

  return {
    get created() {
      return created
    },

    get createdWith() {
      return createdWith
    },

    get chosenModels() {
      return chosenModels
    },

    get renames() {
      return renames
    },

    async compact({ threadId, anchor, fromSeq, throughSeq, summary }) {
      return (
        args.log?.replaceWithSummary({
          threadId,
          anchor,
          fromSeq,
          throughSeq,
          summary,
          discardRows: false,
        }) ?? 0
      )
    },

    async summarise({ threadId, anchor, fromSeq, throughSeq, summary }) {
      return (
        args.log?.replaceWithSummary({
          threadId,
          anchor,
          fromSeq,
          throughSeq,
          summary,
          discardRows: true,
        }) ?? 0
      )
    },

    async fork({ from, seq, mode, title }) {
      created += 1
      const source = rows.find((row) => row.id === from)
      const row: ThreadSummary = {
        id: toThreadId(`forked-${created}`),
        head: seq,
        createdAt: AT,
        updatedAt: AT,
        parent: { threadId: from, forkSeq: seq },
        forkMode: mode,
        workspace: source?.workspace ?? workspaceOf,
        repo: source?.repo ?? null,
        ...(title === undefined ? {} : { title }),
      }
      rows.push(row)
      return row
    },

    async create({ workspace, repo, agent } = {}) {
      created += 1
      createdWith.push({
        workspace: workspace ?? null,
        repo: repo ?? null,
        ...(agent === undefined ? {} : { agent }),
      })
      const row: ThreadSummary = {
        id: toThreadId(`made-${created}`),
        head: 0,
        createdAt: AT,
        updatedAt: AT,
        workspace: workspace ?? workspaceOf,
        repo: repo ?? null,
        ...(agent === undefined ? {} : { agent }),
      }
      rows.push(row)
      return row
    },

    async createWithFirstEvents({ threadId, drafts, runId, title, workspace, repo, agent }) {
      created += 1
      createdWith.push({
        workspace: workspace ?? null,
        repo: repo ?? null,
        ...(agent === undefined ? {} : { agent }),
      })
      const thread: ThreadSummary = {
        id: threadId ?? toThreadId(`made-${created}`),
        head: drafts.length,
        createdAt: AT,
        updatedAt: AT,
        workspace: workspace ?? workspaceOf,
        repo: repo ?? null,
        ...(title === undefined ? {} : { title }),
        ...(agent === undefined ? {} : { agent }),
      }
      rows.push(thread)

      const events = (await args.log?.append({ threadId: thread.id, runId, drafts })) ?? []
      return { thread, events: [...events] }
    },

    async find({ threadId }) {
      return rows.find((row) => row.id === threadId)
    },

    /**
     * Filtered on the supervision link rather than on `parent`, so a fork never comes back from it.
     */
    async spawned({ threadId }) {
      return rows.filter((row) => row.agent?.spawnedBy === threadId)
    },

    async mostRecent({ workspace }) {
      return rows.filter((row) => row.workspace === workspace).at(-1)
    },

    async list({ workspace, limit }) {
      const scoped = rows.filter((row) => row.workspace === workspace).reverse()
      return limit === undefined ? scoped : scoped.slice(0, limit)
    },

    async rename({ threadId, title }) {
      renames.push({ threadId, title })
      const row = rows.find((held) => held.id === threadId)
      if (row !== undefined) row.title = title
    },

    async adopt({ threadId, workspace, repo }) {
      const row = rows.find((held) => held.id === threadId)
      if (row === undefined) return

      row.workspace = workspace
      row.repo = repo
    },

    async chooseModel({ threadId, model }) {
      chosenModels.push({ threadId, model })
      const row = rows.find((held) => held.id === threadId)
      if (row !== undefined) row.model = model
    },

    async rewind({ threadId, toSeq }) {
      const row = rows.find((held) => held.id === threadId)
      if (row !== undefined) row.head = toSeq
      args.log?.truncate({ threadId, toSeq })
    },
  }
}

export type FakeEventLog = EventLogPort & {
  readonly branchesRead: readonly ThreadId[]
  readonly ownReads: readonly ThreadId[]
  truncate(args: { threadId: ThreadId; toSeq: number }): void
  replaceWithSummary(args: {
    threadId: ThreadId
    anchor: ECompactionAnchor
    fromSeq: number
    throughSeq: number
    summary: string
    discardRows: boolean
  }): number
}

export function fakeEventLog(seeded: readonly Event[] = []): FakeEventLog {
  const byThread = new Map<ThreadId, Event[]>()
  const headByThread = new Map<ThreadId, number>()
  const branchesRead: ThreadId[] = []
  const ownReads: ThreadId[] = []

  for (const event of seeded) {
    byThread.set(event.threadId, [...(byThread.get(event.threadId) ?? []), event])
    headByThread.set(event.threadId, Math.max(headByThread.get(event.threadId) ?? 0, event.seq))
  }

  let stamped = 0

  const reserve = ({ threadId, count }: { threadId: ThreadId; count: number }): number => {
    const from = (headByThread.get(threadId) ?? 0) + 1
    headByThread.set(threadId, from + count - 1)
    return from
  }

  const held = ({ threadId, upTo }: { threadId: ThreadId; upTo?: number }): Event[] => {
    const rows = byThread.get(threadId) ?? []
    return upTo === undefined ? [...rows] : rows.filter((event) => event.seq <= upTo)
  }

  return {
    branchesRead,
    ownReads,

    async append({ threadId, runId, drafts }) {
      const firstSeq = reserve({ threadId, count: drafts.length })

      const written = drafts.map((draft, index) => {
        stamped += 1
        return stampEvent({
          draft,
          envelope: {
            id: toEventId(`event-${stamped}`),
            seq: firstSeq + index,
            threadId,
            runId,
            depth: 0,
            at: AT,
          },
        })
      })

      byThread.set(threadId, [...(byThread.get(threadId) ?? []), ...written])
      return written
    },

    replaceWithSummary({ threadId, anchor, fromSeq, throughSeq, summary, discardRows }) {
      const rows = byThread.get(threadId) ?? []
      const inRange = (event: Event): boolean => event.seq >= fromSeq && event.seq <= throughSeq
      const compactable = rows.filter((event) => inRange(event) && event.type !== 'context-loaded')
      const spared = rows.filter((event) => inRange(event) && event.type === 'context-loaded')
      const summarySeq = discardRows
        ? standInSeq({ anchor, fromSeq, throughSeq })
        : reserve({ threadId, count: 1 })
      stamped += 1

      const watermark = stampEvent({
        draft: {
          type: 'history-compacted',
          anchor,
          fromSeq,
          throughSeq,
          summary,
          replaced: compactable.length,
        },
        envelope: {
          id: toEventId(`event-${stamped}`),
          seq: summarySeq,
          threadId,
          runId: toRunId('run-compaction'),
          depth: 0,
          at: AT,
        },
      })

      byThread.set(threadId, [
        ...spared,
        watermark,
        ...rows.filter((event) => event.seq > throughSeq),
      ])
      return compactable.length
    },

    truncate({ threadId, toSeq }) {
      byThread.set(threadId, held({ threadId, upTo: toSeq }))
      headByThread.set(threadId, toSeq)
    },

    async read({ threadId, upTo }) {
      branchesRead.push(threadId)
      return held({ threadId, ...(upTo === undefined ? {} : { upTo }) })
    },

    async head({ threadId }) {
      return headByThread.get(threadId) ?? 0
    },

    async readOwn({ threadId, upTo }) {
      ownReads.push(threadId)
      return held({ threadId, ...(upTo === undefined ? {} : { upTo }) })
    },
  }
}

const standInSeq = ({
  anchor,
  fromSeq,
  throughSeq,
}: {
  anchor: ECompactionAnchor
  fromSeq: number
  throughSeq: number
}): number => (anchor === ECompactionAnchor.Prefix ? throughSeq : fromSeq)

export type FakeLedger = TurnLedgerPort & { readonly rows: readonly TurnSpend[] }

/**
 * `children` is what makes `forThreadTree` able to answer with anything: the ledger holds spend by
 * thread and has no idea which of them was delegated, so a test that cares has to say.
 */
export function fakeLedger(
  args: {
    spent?: readonly TurnSpend[]
    children?: Readonly<Record<string, readonly ThreadId[]>>
  } = {},
): FakeLedger {
  const rows: TurnSpend[] = [...(args.spent ?? [])]

  return {
    get rows() {
      return rows
    },
    record: async (spend) => {
      rows.push(spend)
    },
    forThread: async ({ threadId }) => rows.filter((row) => row.threadId === threadId),

    forThreadTree: async ({ threadId }) => {
      const children = new Set<string>(args.children?.[threadId] ?? [])

      return {
        own: rows.filter((row) => row.threadId === threadId),
        delegated: rows.filter((row) => children.has(row.threadId)),
      }
    },
  }
}
