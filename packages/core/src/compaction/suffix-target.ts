import type { Event } from '../events/envelope'
import { pendingCalls } from '../events/projections'
import { ECompactionRefusal, type CompactionTarget } from './compaction-target'
import { compactedThrough } from './watermark'

export function suffixCompactionTarget({
  events,
  fromSeq,
}: {
  events: readonly Event[]
  fromSeq: number
}): CompactionTarget {
  const firstSeq = events[0]?.seq ?? 0
  const lastSeq = events.at(-1)?.seq ?? 0

  if (!Number.isInteger(fromSeq) || fromSeq < firstSeq || fromSeq > lastSeq) {
    return {
      allowed: false,
      refusal: ECompactionRefusal.NoSuchTarget,
      reason: `${fromSeq} is not a compaction target on a thread holding sequences ${firstSeq} through ${lastSeq}`,
    }
  }

  const already = compactedThrough(events)
  if (fromSeq <= already) {
    return {
      allowed: false,
      refusal: ECompactionRefusal.AlreadyCompacted,
      reason: `this thread is already compacted through ${already}`,
    }
  }

  if (events.filter((event) => event.seq >= fromSeq).length < 2) {
    return {
      allowed: false,
      refusal: ECompactionRefusal.NothingToCompact,
      reason: `summarising from ${fromSeq} would replace one event with a summary of it, which saves nothing`,
    }
  }

  const stranded = pendingCalls(events.filter((event) => event.seq < fromSeq))[0]
  if (stranded !== undefined) {
    return {
      allowed: false,
      refusal: ECompactionRefusal.SplitsToolCall,
      reason: `summarising from ${fromSeq} would leave ${stranded.name} (${stranded.callId}) dispatched with its result summarised away, so the next turn would run it again`,
    }
  }

  return { allowed: true }
}
