import type { Event } from '../../events/envelope'
import type { ERiskDimension } from './dimension'
import type { RiskSignal } from './signals'

export enum EGrantScope {
  Thread = 'thread',
}

export type Grant = {
  grantId: string
  dimensions: readonly ERiskDimension[]
  scope: EGrantScope
  subject: string
  reason: string
  seq: number
}

export function grantsFrom(events: readonly Event[]): readonly Grant[] {
  const live = new Map<string, Grant>()

  for (const event of events) {
    if (event.type === 'permission-revoked') {
      live.delete(event.grantId)
      continue
    }
    if (event.type !== 'permission-granted') continue

    live.set(event.grantId, {
      grantId: event.grantId,
      dimensions: event.dimensions,
      scope: event.scope,
      subject: event.subject,
      reason: event.reason,
      seq: event.seq,
    })
  }

  return [...live.values()].sort((one, other) => one.seq - other.seq)
}

export function grantCovering({
  signal,
  grants,
}: {
  signal: RiskSignal
  grants: readonly Grant[]
}): Grant | undefined {
  if (signal.ungrantable) return undefined

  return grants.findLast(
    (grant) => grant.subject === signal.subject && grant.dimensions.includes(signal.dimension),
  )
}

export type GrantOffer = { subject: string; dimensions: readonly ERiskDimension[] }

export function grantOffersOf({
  signals,
}: {
  signals: readonly RiskSignal[]
}): readonly GrantOffer[] {
  if (signals.some((signal) => signal.ungrantable)) return []

  const dimensionsBySubject = new Map<string, ERiskDimension[]>()

  for (const signal of signals) {
    const gathered = dimensionsBySubject.get(signal.subject)
    if (gathered === undefined) {
      dimensionsBySubject.set(signal.subject, [signal.dimension])
      continue
    }
    if (!gathered.includes(signal.dimension)) gathered.push(signal.dimension)
  }

  return [...dimensionsBySubject].map(([subject, dimensions]) => ({ subject, dimensions }))
}
