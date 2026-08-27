import type { AssistantPart, CallId, Event, EventId, EventOfType } from '@dltech/atlas-core'

import { modelEntries } from './model-entries'
import { shellEndedLine, shellEndingFailed } from './shell-ended-line'
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

function inOneBreath(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.reduce<TranscriptEntry[]>((folded, entry) => {
    const open = folded.at(-1)
    if (
      entry.kind !== EEntryKind.OperatorSaid ||
      open?.kind !== EEntryKind.OperatorSaid ||
      open.steer !== entry.steer
    ) {
      return [...folded, entry]
    }

    folded[folded.length - 1] = {
      ...open,
      text: `${open.text}\n${entry.text}`,
      said: [...open.said, ...entry.said],
    }
    return folded
  }, [])
}

export function durableEntries(events: readonly Event[]): TranscriptEntry[] {
  const opened = new Map<string, ToolGroup>(
    toolGroups(events).map((group) => [group.openedBy, group]),
  )
  const steers = saidWhileToolsWereOutstanding(events)

  return inOneBreath(
    events.flatMap((event): TranscriptEntry[] => {
      if (event.type === 'user-said') {
        return [
          {
            kind: EEntryKind.OperatorSaid,
            author: EAuthor.Operator,
            key: event.id,
            text: event.text,
            said: [event.text],
            steer: steers.has(event.id),
          },
        ]
      }

      if (event.type === 'assistant-said') return entriesOfAssistantEvent(event)

      if (event.type === 'tool-called') {
        const group = opened.get(event.callId)
        return group === undefined ? [] : [toolsRanEntry(group)]
      }

      if (event.type === 'background-shell-ended') {
        return [
          {
            kind: EEntryKind.BackgroundShellEnded,
            author: EAuthor.Model,
            key: event.id,
            text: shellEndedLine(event),
            shellId: event.shellId,
            output: event.output,
            failed: shellEndingFailed(event),
          },
        ]
      }

      if (event.type === 'history-compacted') {
        return [
          {
            kind: EEntryKind.HistoryCompacted,
            author: EAuthor.Model,
            key: event.id,
            text: event.summary,
            compactedEntries: event.replaced,
          },
        ]
      }

      return []
    }),
  )
}
