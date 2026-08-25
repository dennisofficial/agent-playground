import type { Event, EventDraft } from '@dltech/atlas-core'

export type ContextIdentity = string

export function contextIdentityOf(draft: EventDraft): ContextIdentity | undefined {
  if (draft.type !== 'context-loaded') return undefined
  return JSON.stringify([draft.slot, draft.key])
}

type PlanEntry = { kind: 'reused'; event: Event } | { kind: 'fresh'; position: number }

export type AppendPlan = {
  fresh: EventDraft[]
  resolve: (stamped: readonly Event[]) => Event[]
}

export function planAppend({
  drafts,
  reusable,
}: {
  drafts: readonly EventDraft[]
  reusable: ReadonlyMap<ContextIdentity, Event>
}): AppendPlan {
  const entries: PlanEntry[] = []
  const fresh: EventDraft[] = []
  const claimed = new Map<ContextIdentity, number>()

  for (const draft of drafts) {
    const identity = contextIdentityOf(draft)
    if (identity === undefined) {
      entries.push({ kind: 'fresh', position: fresh.length })
      fresh.push(draft)
      continue
    }

    const reused = reusable.get(identity)
    if (reused) {
      entries.push({ kind: 'reused', event: reused })
      continue
    }

    const claimedPosition = claimed.get(identity)
    if (claimedPosition !== undefined) {
      entries.push({ kind: 'fresh', position: claimedPosition })
      continue
    }

    claimed.set(identity, fresh.length)
    entries.push({ kind: 'fresh', position: fresh.length })
    fresh.push(draft)
  }

  return {
    fresh,
    resolve: (stamped) =>
      entries.map((entry) => {
        if (entry.kind === 'reused') return entry.event
        const event = stamped[entry.position]
        if (!event) throw new Error(`append plan expected a stamped event at position ${entry.position}`)
        return event
      }),
  }
}
