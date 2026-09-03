import type { Event, EventOfType } from '../events/envelope'

export type TldrFooter = EventOfType<'tldr-written'>

export function latestTldrPerAnchor(events: readonly Event[]): readonly TldrFooter[] {
  const latest = new Map<number, TldrFooter>()
  for (const event of events) {
    if (event.type !== 'tldr-written') continue
    const held = latest.get(event.anchorSeq)
    if (held === undefined || held.seq < event.seq) latest.set(event.anchorSeq, event)
  }

  return [...latest.values()].sort((a, b) => a.throughSeq - b.throughSeq)
}
