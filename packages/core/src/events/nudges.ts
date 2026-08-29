import type { Event, EventOfType } from './envelope'
import type { EventId } from './ids'

export function liveNudges(events: readonly Event[]): readonly EventOfType<'nudge'>[] {
  const live: EventOfType<'nudge'>[] = []
  let stepsSince = 0

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue

    if (event.type === 'assistant-said') {
      stepsSince += 1
      continue
    }

    if (event.type === 'nudge' && stepsSince < event.lifetimeSteps) live.push(event)
  }

  return live.reverse()
}

export const liveNudgeIds = (events: readonly Event[]): ReadonlySet<EventId> =>
  new Set(liveNudges(events).map((event) => event.id))
