import type { Event } from './envelope'
import { EForkMode } from './fork'
import { outstandingApproval, pendingCalls } from './projections'

export enum EForkRefusal {
  NoSuchTarget = 'no-such-target',
  UnsettledToolCall = 'unsettled-tool-call',
  UnansweredApproval = 'unanswered-approval',
}

export type ForkTarget = { allowed: true } | { allowed: false; refusal: EForkRefusal; reason: string }

export function forkTarget({
  events,
  seq,
  mode,
}: {
  events: readonly Event[]
  seq: number
  mode: EForkMode
}): ForkTarget {
  const firstSeq = events[0]?.seq ?? 0
  const lastSeq = events.at(-1)?.seq ?? 0

  if (!Number.isInteger(seq) || seq < firstSeq || seq > lastSeq) {
    return {
      allowed: false,
      refusal: EForkRefusal.NoSuchTarget,
      reason: `${seq} is not a fork target on a thread holding sequences ${firstSeq} through ${lastSeq}`,
    }
  }

  const prefix = events.filter((event) => event.seq <= seq)

  const unsettled = pendingCalls(prefix)[0]
  if (unsettled !== undefined) {
    return {
      allowed: false,
      refusal: EForkRefusal.UnsettledToolCall,
      reason: `a ${mode} fork at ${seq} would hand the new thread ${unsettled.name} (${unsettled.callId}) dispatched but unsettled, so its first turn would run it a second time`,
    }
  }

  const unanswered = outstandingApproval(prefix)
  if (unanswered !== undefined) {
    return {
      allowed: false,
      refusal: EForkRefusal.UnansweredApproval,
      reason: `a ${mode} fork at ${seq} would start the new thread paused on the approval for ${unanswered}, which was asked of the original thread`,
    }
  }

  return { allowed: true }
}
