import type { Event } from '../events/envelope'
import { estimateEventTokens } from '../models/usage'
import { compactionTarget } from './compaction-target'
import { compactedThrough } from './watermark'

export type CompactionPlan = {
  throughSeq: number
  compactedEvents: number
  keptEvents: number
}

const tailTokensFrom = ({ events, seq }: { events: readonly Event[]; seq: number }): number =>
  estimateEventTokens(events.filter((event) => event.seq >= seq))

function candidateWatermarks({
  events,
  keepRecentTokens,
}: {
  events: readonly Event[]
  keepRecentTokens: number
}): readonly number[] {
  const already = compactedThrough(events)

  const turnStarts = events
    .filter((event) => event.type === 'user-said' && event.seq - 1 > already)
    .map((event) => event.seq)
    .filter((seq) => tailTokensFrom({ events, seq }) >= keepRecentTokens)

  return turnStarts.map((seq) => seq - 1).reverse()
}

export function planCompaction({
  events,
  keepRecentTokens,
}: {
  events: readonly Event[]
  keepRecentTokens: number
}): CompactionPlan | undefined {
  const throughSeq = candidateWatermarks({ events, keepRecentTokens }).find(
    (candidate) => compactionTarget({ events, throughSeq: candidate }).allowed,
  )
  if (throughSeq === undefined) return undefined

  const compactedEvents = events.filter((event) => event.seq <= throughSeq).length

  return {
    throughSeq,
    compactedEvents,
    keptEvents: events.length - compactedEvents,
  }
}
