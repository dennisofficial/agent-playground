import type { Event } from '../events/envelope'

const PAYLOAD_CHARACTER_LIMIT = 600

const ELLIPSIS = '…'

const clipped = (text: string): string =>
  text.length <= PAYLOAD_CHARACTER_LIMIT ? text : `${text.slice(0, PAYLOAD_CHARACTER_LIMIT)}${ELLIPSIS}`

function jsonOrDescription(value: unknown): string {
  if (typeof value === 'string') return clipped(value)

  try {
    return clipped(JSON.stringify(value) ?? String(value))
  } catch {
    return `(unrenderable ${typeof value})`
  }
}

function lineOf(event: Event): string | undefined {
  if (event.type === 'history-compacted') return `Summary of the conversation before this: ${event.summary}`
  if (event.type === 'user-said') return `Operator: ${clipped(event.text)}`

  if (event.type === 'assistant-said') {
    const spoken = event.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    return spoken === '' ? undefined : `Atlas: ${clipped(spoken)}`
  }

  if (event.type === 'tool-called') {
    return `Atlas called ${event.name} with ${jsonOrDescription(event.input)}`
  }

  if (event.type === 'tool-result') {
    if (event.error !== undefined) return `${event.name} failed: ${clipped(event.error.message)}`
    return `${event.name} returned ${jsonOrDescription(event.modelText ?? event.output)}`
  }

  if (event.type === 'tool-denied') return `${event.name} was denied: ${clipped(event.reason)}`

  return undefined
}

export function transcriptOfRange({
  events,
  fromSeq = 0,
  throughSeq,
}: {
  events: readonly Event[]
  fromSeq?: number | undefined
  throughSeq: number
}): string {
  return events
    .filter((event) => event.seq >= fromSeq && event.seq <= throughSeq)
    .flatMap((event) => {
      const line = lineOf(event)
      return line === undefined ? [] : [line]
    })
    .join('\n')
}
