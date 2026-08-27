import type { BranchId, CallId, EventId, RunId } from '../events/ids'

export abstract class IdPort {
  abstract nextBranchId(): BranchId
  abstract nextRunId(): RunId
  abstract nextEventId(): EventId
  abstract nextCallId(): CallId
}
