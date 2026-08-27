import type { Event } from '../events/envelope'
import { toEventId } from '../events/ids'

const PREVIEW_EVENT_ID = 'preview-compaction'

export function eventsWithCompaction({
  events,
  throughSeq,
  summary,
}: {
  events: readonly Event[]
  throughSeq: number
  summary: string
}): readonly Event[] {
  const last = events.at(-1)
  if (last === undefined) return events

  const kept = events.filter((event) => event.seq > throughSeq)

  return [
    {
      type: 'history-compacted',
      throughSeq,
      summary,
      replaced: events.length - kept.length,
      id: toEventId(PREVIEW_EVENT_ID),
      seq: throughSeq,
      branchId: last.branchId,
      runId: last.runId,
      depth: last.depth,
      at: last.at,
    },
    ...kept,
  ]
}
