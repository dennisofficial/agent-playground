import type { EventDraft } from '../events/body'
import type { Event } from '../events/envelope'
import type { BranchId, RunId } from '../events/ids'

export abstract class EventLogPort {
  abstract append(args: {
    branchId: BranchId
    runId: RunId
    parentRunId?: RunId | undefined
    depth?: number | undefined
    drafts: readonly EventDraft[]
  }): Promise<Event[]>

  abstract read(args: { branchId: BranchId; upTo?: number }): Promise<Event[]>

  abstract head(args: { branchId: BranchId }): Promise<number>

  abstract forkFrom(args: { branchId: BranchId; seq: number; into: BranchId }): Promise<void>
}
