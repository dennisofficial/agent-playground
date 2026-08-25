import type { EventDraft } from './body'
import type { Event, EventEnvelope } from './envelope'

export function stampEvent<TDraft extends EventDraft>({
  draft,
  envelope,
}: {
  draft: TDraft
  envelope: EventEnvelope
}): TDraft & EventEnvelope {
  return { ...draft, ...envelope }
}

export function stampDrafts({
  drafts,
  envelopes,
}: {
  drafts: readonly EventDraft[]
  envelopes: readonly EventEnvelope[]
}): Event[] {
  return drafts.map((draft, index) => {
    const envelope = envelopes[index]
    if (!envelope) throw new Error(`no envelope for draft at index ${index}`)
    return stampEvent({ draft, envelope })
  })
}
