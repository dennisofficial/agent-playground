import {
  stampEvent,
  toBranchId,
  toEventId,
  toRunId,
  type BranchId,
  type Event,
  type EventLogPort,
} from '@dltech/atlas-core'
import type { BranchStorePort, BranchSummary } from '@dltech/atlas-harness'

const AT = '2026-08-25T00:00:00.000Z'

export type FakeBranchStore = BranchStorePort & {
  readonly created: number
  readonly renames: readonly { branchId: BranchId; title: string }[]
}

export function fakeBranchStore(
  args: { existing?: readonly BranchId[]; log?: FakeEventLog } = {},
): FakeBranchStore {
  const rows: BranchSummary[] = (args.existing ?? []).map((id) => ({
    id,
    head: 0,
    createdAt: AT,
    updatedAt: AT,
  }))

  let created = 0
  const renames: { branchId: BranchId; title: string }[] = []

  return {
    get created() {
      return created
    },

    get renames() {
      return renames
    },

    async compact({ branchId, throughSeq, summary }) {
      return args.log?.replaceWithSummary({ branchId, throughSeq, summary }) ?? 0
    },

    async fork({ from, seq, title }) {
      created += 1
      const row: BranchSummary = {
        id: toBranchId(`forked-${created}`),
        head: seq,
        createdAt: AT,
        updatedAt: AT,
        parent: { branchId: from, forkSeq: seq },
        ...(title === undefined ? {} : { title }),
      }
      rows.push(row)
      return row
    },

    async create() {
      created += 1
      const row: BranchSummary = {
        id: toBranchId(`made-${created}`),
        head: 0,
        createdAt: AT,
        updatedAt: AT,
      }
      rows.push(row)
      return row
    },

    async find({ branchId }) {
      return rows.find((row) => row.id === branchId)
    },

    async mostRecent() {
      return rows.at(-1)
    },

    async rename({ branchId, title }) {
      renames.push({ branchId, title })
      const row = rows.find((held) => held.id === branchId)
      if (row !== undefined) row.title = title
    },

    async rewind({ branchId, toSeq }) {
      const row = rows.find((held) => held.id === branchId)
      if (row !== undefined) row.head = toSeq
      args.log?.truncate({ branchId, toSeq })
    },
  }
}

export type FakeEventLog = EventLogPort & {
  readonly branchesRead: readonly BranchId[]
  truncate(args: { branchId: BranchId; toSeq: number }): void
  replaceWithSummary(args: { branchId: BranchId; throughSeq: number; summary: string }): number
}

export function fakeEventLog(seeded: readonly Event[] = []): FakeEventLog {
  const byBranch = new Map<BranchId, Event[]>()
  const branchesRead: BranchId[] = []

  for (const event of seeded) {
    byBranch.set(event.branchId, [...(byBranch.get(event.branchId) ?? []), event])
  }

  let stamped = 0

  return {
    branchesRead,

    async append({ branchId, runId, drafts }) {
      const held = byBranch.get(branchId) ?? []

      const written = drafts.map((draft, index) => {
        stamped += 1
        return stampEvent({
          draft,
          envelope: {
            id: toEventId(`event-${stamped}`),
            seq: held.length + index + 1,
            branchId,
            runId,
            depth: 0,
            at: AT,
          },
        })
      })

      byBranch.set(branchId, [...held, ...written])
      return written
    },

    replaceWithSummary({ branchId, throughSeq, summary }) {
      const held = byBranch.get(branchId) ?? []
      const compactable = held.filter(
        (event) => event.seq <= throughSeq && event.type !== 'context-loaded',
      )
      const spared = held.filter(
        (event) => event.seq <= throughSeq && event.type === 'context-loaded',
      )
      stamped += 1

      const watermark = stampEvent({
        draft: { type: 'history-compacted', throughSeq, summary, replaced: compactable.length },
        envelope: {
          id: toEventId(`event-${stamped}`),
          seq: throughSeq,
          branchId,
          runId: toRunId('run-compaction'),
          depth: 0,
          at: AT,
        },
      })

      byBranch.set(branchId, [
        ...spared,
        watermark,
        ...held.filter((event) => event.seq > throughSeq),
      ])
      return compactable.length
    },

    truncate({ branchId, toSeq }) {
      const held = byBranch.get(branchId) ?? []
      byBranch.set(
        branchId,
        held.filter((event) => event.seq <= toSeq),
      )
    },

    async read({ branchId }) {
      branchesRead.push(branchId)
      return [...(byBranch.get(branchId) ?? [])]
    },

    async head({ branchId }) {
      return byBranch.get(branchId)?.length ?? 0
    },

    async readOwn({ branchId, upTo }) {
      return this.read({ branchId, ...(upTo === undefined ? {} : { upTo }) })
    },
  }
}
