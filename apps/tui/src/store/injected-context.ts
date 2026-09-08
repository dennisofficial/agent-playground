import { EContextSlot, type Event, type EventId, type EventOfType } from '@dltech/atlas-core'

import { EAuthor, EEntryKind, type ContextLoadedEntry } from './transcript-model'

const TOOL_ACTIVITY: ReadonlySet<Event['type']> = new Set(['tool-called', 'tool-result', 'tool-denied'])

const MESSAGE_BADGES: ReadonlySet<string> = new Set([EContextSlot.Skill, EContextSlot.File])

type ContextLoad = EventOfType<'context-loaded'>

const labelOf = (load: ContextLoad): string =>
  load.slot === EContextSlot.NestedInstructions ? load.key : load.slot

const entryOf = (loads: readonly ContextLoad[], key: string): ContextLoadedEntry => ({
  kind: EEntryKind.ContextLoaded,
  author: EAuthor.Model,
  key,
  text: `Context: ${loads.map(labelOf).join(', ')}`,
  body: loads.map((load) => `${labelOf(load)}\n${load.content.trimEnd()}`).join('\n\n'),
})

export type InjectedContextBlocks = {
  heads: ReadonlyMap<EventId, ContextLoadedEntry>
}

export function injectedContextBlocks(events: readonly Event[]): InjectedContextBlocks {
  const heads = new Map<EventId, ContextLoadedEntry>()
  let group: ContextLoad[] = []
  let afterTool = false

  const flush = (): void => {
    const first = group[0]
    if (first !== undefined) heads.set(first.id, entryOf(group, first.id))
    group = []
  }

  for (const event of events) {
    if (event.type === 'context-loaded') {
      if (afterTool && !MESSAGE_BADGES.has(event.slot)) group.push(event)
      continue
    }
    flush()
    afterTool = TOOL_ACTIVITY.has(event.type)
  }
  flush()

  return { heads }
}
