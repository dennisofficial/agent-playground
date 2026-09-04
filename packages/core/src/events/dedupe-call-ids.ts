import type { EventDraft } from './body'
import { toCallId, type CallId } from './ids'
import type { Event } from './envelope'

/**
 * kimi numbers tool calls per request (`bash_181`), so a rewound or compacted thread sees the same
 * id called again, and a glitching model can emit one id twice in a single step. Providers reject
 * an exchange whose tool_use ids repeat, so uniqueness is enforced where new calls enter the log.
 */
export function dedupeCallIds(args: {
  drafts: readonly EventDraft[]
  taken: ReadonlySet<string>
}): EventDraft[] {
  const used = new Set<string>(args.taken)
  const openByOldId = new Map<string, CallId>()

  const fresh = (oldId: string): CallId => {
    let suffix = 2
    while (used.has(`${oldId}~${suffix}`)) suffix += 1
    return toCallId(`${oldId}~${suffix}`)
  }

  return args.drafts.map((draft) => {
    if (draft.type === 'tool-called') {
      const oldId = draft.callId as string
      const callId = used.has(oldId) ? fresh(oldId) : draft.callId
      used.add(callId as string)
      openByOldId.set(oldId, callId)
      return callId === draft.callId ? draft : { ...draft, callId }
    }

    if (
      draft.type === 'tool-result' ||
      draft.type === 'tool-denied' ||
      draft.type === 'approval-requested' ||
      draft.type === 'approval-answered'
    ) {
      const renamed = openByOldId.get(draft.callId as string)
      if (renamed === undefined) return draft
      if (draft.type === 'tool-result' || draft.type === 'tool-denied') {
        openByOldId.delete(draft.callId as string)
      }
      return renamed === draft.callId ? draft : { ...draft, callId: renamed }
    }

    return draft
  })
}

export function callIdsIn(events: readonly Event[]): ReadonlySet<string> {
  const taken = new Set<string>()

  for (const event of events) {
    if (
      event.type === 'tool-called' ||
      event.type === 'tool-result' ||
      event.type === 'tool-denied' ||
      event.type === 'approval-requested' ||
      event.type === 'approval-answered'
    ) {
      taken.add(event.callId as string)
    }
  }

  return taken
}
