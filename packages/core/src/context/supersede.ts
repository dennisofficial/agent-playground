import type { Event, EventOfType } from '../events/envelope'

const identityOf = (event: EventOfType<'context-loaded'>): string =>
  JSON.stringify([event.slot, event.key])

export function currentContextEvents(
  events: readonly Event[],
): readonly EventOfType<'context-loaded'>[] {
  const latest = new Map<string, EventOfType<'context-loaded'>>()

  for (const event of events) {
    if (event.type !== 'context-loaded') continue
    latest.set(identityOf(event), event)
  }

  return [...latest.values()].sort((left, right) => left.seq - right.seq)
}

export function supersededContextIds(events: readonly Event[]): ReadonlySet<string> {
  const current = new Set(currentContextEvents(events).map((event) => event.id))

  return new Set(
    events
      .filter((event) => event.type === 'context-loaded' && !current.has(event.id))
      .map((event) => event.id),
  )
}
