import type { EventDraft } from '../events/body'
import type { Event } from '../events/envelope'
import type { BranchId, RunId } from '../events/ids'

export interface EventLogPort {
  append(args: {
    branchId: BranchId
    runId: RunId
    drafts: readonly EventDraft[]
  }): Promise<Event[]>

  read(args: { branchId: BranchId; upTo?: number }): Promise<Event[]>

  head(args: { branchId: BranchId }): Promise<number>

  forkFrom(args: { branchId: BranchId; seq: number; into: BranchId }): Promise<void>
}
