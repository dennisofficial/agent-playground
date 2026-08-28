import type { Event } from '../events/envelope'
import type { CallId } from '../events/ids'
import { compactedThrough } from './watermark'

export enum ECompactionRefusal {
  NoSuchTarget = 'no-such-target',
  AlreadyCompacted = 'already-compacted',
  SplitsToolCall = 'splits-tool-call',
  NothingToCompact = 'nothing-to-compact',
}

export type CompactionTarget =
  | { allowed: true }
  | { allowed: false; refusal: ECompactionRefusal; reason: string }

type Settlement = { callId: CallId; name: string; seq: number }

const settlements = (events: readonly Event[]): readonly Settlement[] =>
  events.flatMap((event) =>
    event.type === 'tool-result' || event.type === 'tool-denied'
      ? [{ callId: event.callId, name: event.name, seq: event.seq }]
      : [],
  )

function orphanedSettlement({
  events,
  throughSeq,
}: {
  events: readonly Event[]
  throughSeq: number
}): Settlement | undefined {
  const compactedCalls = new Set(
    events.flatMap((event) =>
      event.type === 'tool-called' && event.seq <= throughSeq ? [event.callId] : [],
    ),
  )

  return settlements(events).find(
    (settlement) => settlement.seq > throughSeq && compactedCalls.has(settlement.callId),
  )
}

export function compactionTarget({
  events,
  throughSeq,
}: {
  events: readonly Event[]
  throughSeq: number
}): CompactionTarget {
  const firstSeq = events[0]?.seq ?? 0
  const lastSeq = events.at(-1)?.seq ?? 0

  if (!Number.isInteger(throughSeq) || throughSeq < firstSeq || throughSeq > lastSeq) {
    return {
      allowed: false,
      refusal: ECompactionRefusal.NoSuchTarget,
      reason: `${throughSeq} is not a compaction target on a thread holding sequences ${firstSeq} through ${lastSeq}`,
    }
  }

  const already = compactedThrough(events)
  if (throughSeq <= already) {
    return {
      allowed: false,
      refusal: ECompactionRefusal.AlreadyCompacted,
      reason: `this thread is already compacted through ${already}`,
    }
  }

  const orphaned = orphanedSettlement({ events, throughSeq })
  if (orphaned !== undefined) {
    return {
      allowed: false,
      refusal: ECompactionRefusal.SplitsToolCall,
      reason: `compacting through ${throughSeq} would keep the result of ${orphaned.name} (${orphaned.callId}) after compacting the call it answers`,
    }
  }

  return { allowed: true }
}
