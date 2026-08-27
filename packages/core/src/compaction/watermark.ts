import type { Event, EventOfType } from '../events/envelope'
import { eventsOfType } from '../events/projections'

export type CompactionWatermark = EventOfType<'history-compacted'>

export function compactionWatermark(events: readonly Event[]): CompactionWatermark | undefined {
  return eventsOfType({ events, type: 'history-compacted' }).reduce<CompactionWatermark | undefined>(
    (deepest, event) => (deepest === undefined || event.throughSeq > deepest.throughSeq ? event : deepest),
    undefined,
  )
}

export function compactedThrough(events: readonly Event[]): number {
  return compactionWatermark(events)?.throughSeq ?? 0
}
