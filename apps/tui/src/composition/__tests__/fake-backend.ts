import {
  stampEvent,
  toThreadId,
  ECompactionAnchor,
  toEventId,
  toRunId,
  type ThreadId,
  type Event,
  type EventLogPort,
} from '@dltech/atlas-core'
import type { ThreadStorePort, ThreadSummary } from '@dltech/atlas-harness'

const AT = '2026-08-25T00:00:00.000Z'

export type FakeThreadStore = ThreadStorePort & {
  readonly created: number
  readonly renames: readonly { threadId: ThreadId; title: string }[]
}

export function fakeThreadStore(
  args: { existing?: readonly ThreadId[]; log?: FakeEventLog } = {},
): FakeThreadStore {
  const rows: ThreadSummary[] = (args.existing ?? []).map((id) => ({
    id,
    head: 0,
    createdAt: AT,
    updatedAt: AT,
  }))

  let created = 0
  const renames: { threadId: ThreadId; title: string }[] = []

  return {
    get created() {
      return created
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

    async fork({ from, seq, title }) {
      created += 1
      const row: ThreadSummary = {
        id: toThreadId(`forked-${created}`),
        head: seq,
        createdAt: AT,
        updatedAt: AT,
        parent: { threadId: from, forkSeq: seq },
        ...(title === undefined ? {} : { title }),
      }
      rows.push(row)
      return row
    },

    async create() {
      created += 1
      const row: ThreadSummary = {
        id: toThreadId(`made-${created}`),
        head: 0,
        createdAt: AT,
        updatedAt: AT,
      }
      rows.push(row)
      return row
    },

    async find({ threadId }) {
      return rows.find((row) => row.id === threadId)
    },

    async mostRecent() {
      return rows.at(-1)
    },

    async rename({ threadId, title }) {
      renames.push({ threadId, title })
      const row = rows.find((held) => held.id === threadId)
      if (row !== undefined) row.title = title
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
  const branchesRead: ThreadId[] = []

  for (const event of seeded) {
    byThread.set(event.threadId, [...(byThread.get(event.threadId) ?? []), event])
  }

  let stamped = 0

  return {
    branchesRead,

    async append({ threadId, runId, drafts }) {
      const held = byThread.get(threadId) ?? []

      const written = drafts.map((draft, index) => {
        stamped += 1
        return stampEvent({
          draft,
          envelope: {
            id: toEventId(`event-${stamped}`),
            seq: held.length + index + 1,
            threadId,
            runId,
            depth: 0,
            at: AT,
          },
        })
      })

      byThread.set(threadId, [...held, ...written])
      return written
    },

    replaceWithSummary({ threadId, anchor, fromSeq, throughSeq, summary, discardRows }) {
      const held = byThread.get(threadId) ?? []
      const inRange = (event: Event): boolean => event.seq >= fromSeq && event.seq <= throughSeq
      const compactable = held.filter((event) => inRange(event) && event.type !== 'context-loaded')
      const spared = held.filter((event) => inRange(event) && event.type === 'context-loaded')
      const summarySeq = discardRows
        ? anchor === ECompactionAnchor.Prefix
          ? throughSeq
          : fromSeq
        : (held.at(-1)?.seq ?? 0) + 1
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
        ...held.filter((event) => event.seq > throughSeq),
      ])
      return compactable.length
    },

    truncate({ threadId, toSeq }) {
      const held = byThread.get(threadId) ?? []
      byThread.set(
        threadId,
        held.filter((event) => event.seq <= toSeq),
      )
    },

    async read({ threadId }) {
      branchesRead.push(threadId)
      return [...(byThread.get(threadId) ?? [])]
    },

    async head({ threadId }) {
      return byThread.get(threadId)?.length ?? 0
    },

    async readOwn({ threadId, upTo }) {
      return this.read({ threadId, ...(upTo === undefined ? {} : { upTo }) })
    },
  }
}
