import type { ThreadId, CallId, EventId, RunId } from '../events/ids'

export abstract class IdPort {
  abstract nextThreadId(): ThreadId
  abstract nextRunId(): RunId
  abstract nextEventId(): EventId
  abstract nextCallId(): CallId
}
