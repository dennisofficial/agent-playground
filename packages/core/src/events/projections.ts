import { EDecision, type EventType } from './body'
import type { Event, EventOfType } from './envelope'
import type { CallId, RunId } from './ids'

export type PendingCall = { callId: CallId; name: string; input: unknown; ordinal: number; runId: RunId }

export function eventsOfType<TType extends EventType>({
  events,
  type,
}: {
  events: readonly Event[]
  type: TType
}): EventOfType<TType>[] {
  return events.filter((event): event is EventOfType<TType> => event.type === type)
}

export function pendingCalls(events: readonly Event[]): PendingCall[] {
  const settled = new Set<CallId>()
  for (const event of events) {
    if (event.type === 'tool-result' || event.type === 'tool-denied') settled.add(event.callId)
  }

  return eventsOfType({ events, type: 'tool-called' })
    .filter((event) => !settled.has(event.callId))
    .map((event) => ({
      callId: event.callId,
      name: event.name,
      input: event.input,
      ordinal: event.ordinal,
      runId: event.runId,
    }))
}

export function answeredApproval({
  events,
  callId,
}: {
  events: readonly Event[]
  callId: CallId
}): EventOfType<'approval-answered'> | undefined {
  return eventsOfType({ events, type: 'approval-answered' })
    .filter((event) => event.callId === callId)
    .at(-1)
}

export function outstandingApproval(events: readonly Event[]): CallId | undefined {
  return eventsOfType({ events, type: 'approval-requested' })
    .map((event) => event.callId)
    .find((callId) => answeredApproval({ events, callId }) === undefined)
}

export function inputForCall({
  events,
  callId,
}: {
  events: readonly Event[]
  callId: CallId
}): unknown {
  const answer = answeredApproval({ events, callId })
  if (answer?.decision === EDecision.Allow && answer.editedInput !== undefined) return answer.editedInput

  return eventsOfType({ events, type: 'tool-called' }).find((event) => event.callId === callId)?.input
}

const TURN_TAKING: readonly EventType[] = [
  'user-said',
  'assistant-said',
  'tool-result',
  'tool-denied',
  'nudge',
]

export function awaitsReply(events: readonly Event[]): boolean {
  const lastTurn = events.filter((event) => TURN_TAKING.includes(event.type)).at(-1)
  return lastTurn !== undefined && lastTurn.type !== 'assistant-said'
}
