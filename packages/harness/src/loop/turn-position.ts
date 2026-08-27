import { awaitsReply, type Event } from '@dltech/atlas-core'

export function messageArrivedSince({
  events,
  seenThrough,
}: {
  events: readonly Event[]
  seenThrough: number | undefined
}): boolean {
  if (seenThrough === undefined) return false
  return awaitsReply(events.filter((event) => event.seq > seenThrough && event.type !== 'assistant-said'))
}

export function committedSinceLastMessage(events: readonly Event[]): boolean {
  const spokenTo = events.findLastIndex((event) => event.type === 'user-said')

  return events
    .slice(spokenTo + 1)
    .some(
      (event) =>
        event.type === 'tool-called' ||
        (event.type === 'assistant-said' && event.parts.some((part) => part.type === 'text')),
    )
}
