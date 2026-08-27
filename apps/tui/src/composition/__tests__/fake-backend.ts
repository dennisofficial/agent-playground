import {
  stampEvent,
  toBranchId,
  toEventId,
  type BranchId,
  type Event,
  type EventLogPort,
} from '@dltech/atlas-core'
import type { BranchStorePort, BranchSummary } from '@dltech/atlas-harness'

const AT = '2026-08-25T00:00:00.000Z'

export type FakeBranchStore = BranchStorePort & { readonly created: number }

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

  return {
    get created() {
      return created
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

    async rename() {},

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

    async forkFrom() {},
  }
}
