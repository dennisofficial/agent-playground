import type { Event } from '../events/envelope'
import { elapsedPhrase } from '../shells/elapsed'

const PAYLOAD_CHARACTER_LIMIT = 600

const ELLIPSIS = '…'

const clipped = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}${ELLIPSIS}`

function jsonOrDescription(value: unknown, limit: number): string {
  if (typeof value === 'string') return clipped(value, limit)

  try {
    return clipped(JSON.stringify(value) ?? String(value), limit)
  } catch {
    return `(unrenderable ${typeof value})`
  }
}

function lineOf(event: Event, payloadLimit: number): string | undefined {
  if (event.type === 'history-compacted') return `Summary of the conversation before this: ${event.summary}`
  if (event.type === 'user-said') return `Operator: ${clipped(event.text, payloadLimit)}`

  if (event.type === 'assistant-said') {
    const spoken = event.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    return spoken === '' ? undefined : `Atlas: ${clipped(spoken, payloadLimit)}`
  }

  if (event.type === 'tool-called') {
    return `Atlas called ${event.name} with ${jsonOrDescription(event.input, payloadLimit)}`
  }

  if (event.type === 'tool-result') {
    if (event.error !== undefined) return `${event.name} failed: ${clipped(event.error.message, payloadLimit)}`
    return `${event.name} returned ${jsonOrDescription(event.modelText ?? event.output, payloadLimit)}`
  }

  if (event.type === 'tool-denied') return `${event.name} was denied: ${clipped(event.reason, payloadLimit)}`

  if (event.type === 'agent-ended') {
    return `Sub-agent (${event.agentType}, ${event.intent}) ${event.status}: ${clipped(event.prose, payloadLimit)}`
  }

  if (event.type === 'background-shell-ended') {
    return `Background shell "${event.command}" ${event.status}: ${clipped(event.output, payloadLimit)}`
  }

  if (event.type === 'background-shell-still-running') {
    return `Background shell "${event.command}" still running after ${elapsedPhrase(event.runningForMs)}`
  }

  if (event.type === 'service-ended') {
    return `Service "${event.command}" ${event.status}: ${clipped(event.tail, payloadLimit)}`
  }

  if (event.type === 'worktree-entered') return `Atlas entered worktree ${event.path} (${event.branch})`
  if (event.type === 'worktree-exited') return `Atlas left worktree ${event.path} (${event.action})`

  return undefined
}

const isProse = (event: Event): boolean =>
  event.type === 'history-compacted' ||
  event.type === 'user-said' ||
  event.type === 'assistant-said'

export function transcriptOfRange({
  events,
  fromSeq = 0,
  throughSeq,
  proseOnly = false,
  payloadLimit = PAYLOAD_CHARACTER_LIMIT,
}: {
  events: readonly Event[]
  fromSeq?: number | undefined
  throughSeq: number
  proseOnly?: boolean | undefined
  payloadLimit?: number | undefined
}): string {
  return events
    .filter((event) => event.seq >= fromSeq && event.seq <= throughSeq)
    .filter((event) => !proseOnly || isProse(event))
    .flatMap((event) => {
      const line = lineOf(event, payloadLimit)
      return line === undefined ? [] : [line]
    })
    .join('\n')
}
