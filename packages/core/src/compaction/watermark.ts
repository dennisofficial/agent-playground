import { ECompactionAnchor, survivesSummary } from '../events/body'
import type { Event, EventOfType } from '../events/envelope'
import { eventsOfType } from '../events/projections'

export type CompactionWatermark = EventOfType<'history-compacted'>

export function compactionWatermarks(events: readonly Event[]): readonly CompactionWatermark[] {
  return eventsOfType({ events, type: 'history-compacted' })
}

export function compactionWatermark(events: readonly Event[]): CompactionWatermark | undefined {
  return compactionWatermarks(events).reduce<CompactionWatermark | undefined>(
    (deepest, event) =>
      deepest === undefined || event.throughSeq > deepest.throughSeq ? event : deepest,
    undefined,
  )
}

const rowsSurviveBelow = ({
  events,
  watermark,
}: {
  events: readonly Event[]
  watermark: CompactionWatermark
}): boolean =>
  events.some(
    (event) =>
      event.seq >= watermark.fromSeq &&
      event.seq <= watermark.throughSeq &&
      event.seq !== watermark.seq &&
      !survivesSummary(event.type),
  )

const prefixWatermarks = (events: readonly Event[]): readonly CompactionWatermark[] =>
  compactionWatermarks(events).filter((event) => event.anchor === ECompactionAnchor.Prefix)

const furthest = (watermarks: readonly CompactionWatermark[]): number =>
  watermarks.reduce((deepest, event) => Math.max(deepest, event.throughSeq), 0)

/** How far a summary already speaks for, whether or not the rows behind it survived. */
export function compactedThrough(events: readonly Event[]): number {
  return furthest(prefixWatermarks(events))
}

/**
 * The lowest sequence a rewind may still name. It rises only where the covered rows are genuinely
 * gone, which is what separates the two operations: compaction hides a range and leaves it
 * rewindable, summarising replaces it and there is nothing underneath to return to. Rows that survive
 * a summary are ignored because they are spared either way, so their survival says nothing about the
 * turns around them.
 */
export function replacedThrough(events: readonly Event[]): number {
  return furthest(
    prefixWatermarks(events).filter((event) => !rowsSurviveBelow({ events, watermark: event })),
  )
}

export type ReplacedRange = { fromSeq: number; throughSeq: number }

/**
 * The ranges a summary genuinely replaced, in either direction: the transcript rows are gone and
 * only the spared types are left standing in them. A spared bookkeeping event in one speaks for a
 * turn the summary already speaks for, so nothing may anchor to it.
 */
export function replacedRanges(events: readonly Event[]): readonly ReplacedRange[] {
  return compactionWatermarks(events)
    .filter((watermark) => !rowsSurviveBelow({ events, watermark }))
    .map((watermark) => ({ fromSeq: watermark.fromSeq, throughSeq: watermark.throughSeq }))
}
