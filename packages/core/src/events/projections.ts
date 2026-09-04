import { EDecision, type EventType } from './body'
import type { Event, EventOfType } from './envelope'
import type { CallId, RunId, ThreadId } from './ids'

export type PendingCall = {
  callId: CallId
  name: string
  input: unknown
  ordinal: number
  runId: RunId
  threadId: ThreadId
}

export function eventsOfType<TType extends EventType>({
  events,
  type,
}: {
  events: readonly Event[]
  type: TType
}): EventOfType<TType>[] {
  return events.filter((event): event is EventOfType<TType> => event.type === type)
}

/**
 * A result settles the most recent open call carrying its id, not every call that ever carried it:
 * some providers number tool calls per request (kimi's `bash_181`), so a rewound or compacted
 * thread will see the same id called again, and only positional matching keeps the fresh call
 * dispatchable.
 */
export function pendingCalls(events: readonly Event[]): PendingCall[] {
  const open = new Map<CallId, EventOfType<'tool-called'>[]>()
  const settled = new Set<EventOfType<'tool-called'>>()

  for (const event of events) {
    if (event.type === 'tool-called') {
      const calls = open.get(event.callId) ?? []
      calls.push(event)
      open.set(event.callId, calls)
      continue
    }

    if (event.type !== 'tool-result' && event.type !== 'tool-denied') continue

    const latest = open.get(event.callId)?.at(-1)
    if (latest === undefined) continue
    settled.add(latest)
    open.set(event.callId, open.get(event.callId)?.slice(0, -1) ?? [])
  }

  return eventsOfType({ events, type: 'tool-called' })
    .filter((event) => !settled.has(event))
    .map((event) => ({
      callId: event.callId,
      name: event.name,
      input: event.input,
      ordinal: event.ordinal,
      runId: event.runId,
      threadId: event.threadId,
    }))
}

export function answeredApproval({
  events,
  callId,
}: {
  events: readonly Event[]
  callId: CallId
}): EventOfType<'approval-answered'> | undefined {
  let answered: EventOfType<'approval-answered'> | undefined

  for (const event of events) {
    if (event.type === 'tool-called' && event.callId === callId) {
      answered = undefined
      continue
    }
    if (event.type === 'approval-answered' && event.callId === callId) answered = event
  }

  return answered
}

export function outstandingApproval(events: readonly Event[]): CallId | undefined {
  const unanswered = new Map<CallId, number>()

  for (const event of events) {
    if (event.type === 'approval-requested') unanswered.set(event.callId, event.seq)
    if (event.type === 'approval-answered') unanswered.delete(event.callId)
  }

  let earliest: { callId: CallId; seq: number } | undefined
  for (const [callId, seq] of unanswered) {
    if (earliest === undefined || seq < earliest.seq) earliest = { callId, seq }
  }

  return earliest?.callId
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

  return eventsOfType({ events, type: 'tool-called' }).findLast((event) => event.callId === callId)?.input
}

const TURN_TAKING: readonly EventType[] = [
  'user-said',
  'assistant-said',
  'tool-result',
  'tool-denied',
  'nudge',
  'background-shell-ended',
  'background-shell-awaiting-input',
  'background-shell-matched',
  'service-ended',
  'agent-ended',
]

export function awaitsReply(events: readonly Event[]): boolean {
  const lastTurn = events.filter((event) => TURN_TAKING.includes(event.type)).at(-1)
  return lastTurn !== undefined && lastTurn.type !== 'assistant-said'
}
