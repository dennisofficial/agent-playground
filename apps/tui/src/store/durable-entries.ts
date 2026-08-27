import type { AssistantPart, CallId, Event, EventId, EventOfType } from '@dltech/atlas-core'

import { modelEntries } from './model-entries'
import { toolGroups, type ToolGroup } from './tool-groups'
import { EAuthor, EEntryKind, toolsRanEntry, type TranscriptEntry } from './transcript-model'

type PartRun = { type: AssistantPart['type']; text: string }

function runsOfParts(parts: readonly AssistantPart[]): PartRun[] {
  return parts.reduce<PartRun[]>((runs, part) => {
    const open = runs.at(-1)
    if (open?.type === part.type) {
      open.text += part.text
      return runs
    }

    return [...runs, { type: part.type, text: part.text }]
  }, [])
}

function entriesOfAssistantEvent(event: EventOfType<'assistant-said'>): TranscriptEntry[] {
  return modelEntries({
    runs: runsOfParts(event.parts).map((run, index) => ({
      key: `${event.id}#${index}`,
      text: run.text,
      isReasoning: run.type === 'reasoning',
    })),
    streaming: false,
    interruptedAtEnd: event.interrupted === true,
  })
}

function saidWhileToolsWereOutstanding(events: readonly Event[]): ReadonlySet<EventId> {
  const outstanding = new Set<CallId>()
  const steers = new Set<EventId>()

  for (const event of events) {
    if (event.type === 'tool-called') outstanding.add(event.callId)
    if (event.type === 'tool-result' || event.type === 'tool-denied') {
      outstanding.delete(event.callId)
    }
    if (event.type === 'user-said' && outstanding.size > 0) steers.add(event.id)
  }

  return steers
}

export function durableEntries(events: readonly Event[]): TranscriptEntry[] {
  const opened = new Map<string, ToolGroup>(
    toolGroups(events).map((group) => [group.openedBy, group]),
  )
  const steers = saidWhileToolsWereOutstanding(events)

  return events.flatMap((event) => {
    if (event.type === 'user-said') {
      return [
        {
          kind: EEntryKind.OperatorSaid,
          author: EAuthor.Operator,
          key: event.id,
          text: event.text,
          steer: steers.has(event.id),
        },
      ]
    }

    if (event.type === 'assistant-said') return entriesOfAssistantEvent(event)

    if (event.type === 'tool-called') {
      const group = opened.get(event.callId)
      return group === undefined ? [] : [toolsRanEntry(group)]
    }

    return []
  })
}
