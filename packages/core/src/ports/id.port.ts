import type { BranchId, CallId, EventId, RunId } from '../events/ids'

export interface IdPort {
  nextBranchId(): BranchId
  nextRunId(): RunId
  nextEventId(): EventId
  nextCallId(): CallId
}
