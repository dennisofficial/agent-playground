import type { Event } from './envelope'
import { outstandingApproval, pendingCalls } from './projections'

export enum ERewindRefusal {
  NoSuchTarget = 'no-such-target',
  UnsettledToolCall = 'unsettled-tool-call',
  UnansweredApproval = 'unanswered-approval',
  BelowInheritedPrefix = 'below-inherited-prefix',
}

export type RewindTarget = { allowed: true } | { allowed: false; refusal: ERewindRefusal; reason: string }

export function rewindTarget({
  events,
  toSeq,
  floorSeq = 0,
}: {
  events: readonly Event[]
  toSeq: number
  floorSeq?: number | undefined
}): RewindTarget {
  const lastSeq = events.at(-1)?.seq ?? 0
  if (!Number.isInteger(toSeq) || toSeq < 0 || toSeq > lastSeq) {
    return {
      allowed: false,
      refusal: ERewindRefusal.NoSuchTarget,
      reason: `${toSeq} is not a rewind target on a branch holding sequences 0 through ${lastSeq}`,
    }
  }

  if (toSeq < floorSeq) {
    return {
      allowed: false,
      refusal: ERewindRefusal.BelowInheritedPrefix,
      reason: `rewinding to ${toSeq} would cut into the ${floorSeq} sequences this branch inherited rather than owns, and the rows below ${floorSeq} belong to its parent`,
    }
  }

  const surviving = events.filter((event) => event.seq <= toSeq)

  const unsettled = pendingCalls(surviving)[0]
  if (unsettled !== undefined) {
    return {
      allowed: false,
      refusal: ERewindRefusal.UnsettledToolCall,
      reason: `rewinding to ${toSeq} would leave ${unsettled.name} (${unsettled.callId}) dispatched but unsettled, so the next turn would run it again`,
    }
  }

  const unanswered = outstandingApproval(surviving)
  if (unanswered !== undefined) {
    return {
      allowed: false,
      refusal: ERewindRefusal.UnansweredApproval,
      reason: `rewinding to ${toSeq} would leave the approval for ${unanswered} unanswered`,
    }
  }

  return { allowed: true }
}
