import type { Event } from '../events/envelope'
import { tldrAnchor } from './anchor'

export type TldrDue = { anchorSeq: number; throughSeq: number }

function contentHead(events: readonly Event[]): number {
  return events.reduce(
    (head, event) => (event.type === 'tldr-written' ? head : Math.max(head, event.seq)),
    0,
  )
}

function spokeAbove({ events, anchorSeq }: { events: readonly Event[]; anchorSeq: number }): boolean {
  return events.some(
    (event) =>
      event.type === 'assistant-said' &&
      event.seq > anchorSeq &&
      event.parts.some((part) => part.type === 'text' && part.text.trim() !== ''),
  )
}

export function tldrDue(events: readonly Event[]): TldrDue | undefined {
  const anchorSeq = tldrAnchor(events)
  if (anchorSeq === undefined) return undefined

  const throughSeq = contentHead(events)
  if (!spokeAbove({ events, anchorSeq })) return undefined

  const covered = events.some(
    (event) =>
      event.type === 'tldr-written' &&
      event.anchorSeq === anchorSeq &&
      event.throughSeq >= throughSeq,
  )
  return covered ? undefined : { anchorSeq, throughSeq }
}
