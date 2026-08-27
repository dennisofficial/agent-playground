import type { EventBody, EventDraft, EventType } from './body'
import type { ThreadId, EventId, RunId } from './ids'

export type EventEnvelope = {
  id: EventId
  seq: number
  threadId: ThreadId
  runId: RunId
  parentRunId?: RunId | undefined
  depth: number
  at: string
}

export type Stamped<TBody> = TBody extends unknown ? TBody & EventEnvelope : never

export type Event = Stamped<EventBody>

export type EventOfType<TType extends EventType> = Extract<Event, { type: TType }>

export type DraftOfType<TType extends EventType> = Extract<EventDraft, { type: TType }>

export type EventRef = { eventId: EventId; seq: number }
