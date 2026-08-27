import type { BranchId, Event, EventLogPort } from '@dltech/atlas-core'
import type { BranchStorePort } from '@dltech/atlas-harness'

export type OpenedConversation = {
  branchId: BranchId
  events: readonly Event[]
  name: string | null
}

export async function openConversation(args: {
  branches: BranchStorePort
  log: EventLogPort
  fresh: boolean
}): Promise<OpenedConversation> {
  const existing = args.fresh ? undefined : await args.branches.mostRecent()
  const branch = existing ?? (await args.branches.create({}))

  return {
    branchId: branch.id,
    events: await args.log.read({ branchId: branch.id }),
    name: branch.title ?? null,
  }
}
