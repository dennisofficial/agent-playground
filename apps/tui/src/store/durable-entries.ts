import { EContextSlot, type AssistantPart, type CallId, type Event, type EventId, type EventOfType } from '@dltech/atlas-core'

import { modelEntries } from './model-entries'
import { shellEndedLine, shellEndingFailed } from './shell-ended-line'
import { toolGroups, type ToolGroup } from './tool-groups'
import type { TurnSpend } from '@dltech/atlas-harness'
import { EAuthor, EEntryKind, toolsRanEntry, type TranscriptEntry } from './transcript-model'
import { turnEndedEntry, turnsBySeq } from './turn-rows'

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

function skillsLoadedWith(events: readonly Event[]): ReadonlyMap<EventId, readonly string[]> {
  const attached = new Map<EventId, readonly string[]>()
  let loaded: string[] = []

  for (const event of events) {
    if (event.type === 'context-loaded') {
      if (event.slot === EContextSlot.Skill) loaded.push(event.key)
      continue
    }

    if (event.type === 'user-said' && loaded.length > 0) attached.set(event.id, loaded)
    loaded = []
  }

  return attached
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
      skills: [...new Set([...open.skills, ...entry.skills])],
    }
    return folded
  }, [])
}

export function durableEntries(args: {
  events: readonly Event[]
  turns?: readonly TurnSpend[] | undefined
}): TranscriptEntry[] {
  const { events } = args
  const opened = new Map<string, ToolGroup>(
    toolGroups(events).map((group) => [group.openedBy, group]),
  )
  const steers = saidWhileToolsWereOutstanding(events)
  const loaded = skillsLoadedWith(events)
  const turns = turnsBySeq({ events, turns: args.turns ?? [] })

  const entriesOfEvent = (event: Event): TranscriptEntry[] => {
    if (event.type === 'user-said') {
      return [
        {
          kind: EEntryKind.OperatorSaid,
          author: EAuthor.Operator,
          key: event.id,
          text: event.text,
          said: [event.text],
          steer: steers.has(event.id),
          skills: loaded.get(event.id) ?? [],
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
  }

  return inOneBreath(
    events.flatMap((event): TranscriptEntry[] => {
      const entries = entriesOfEvent(event)
      const turn = turns.get(event.seq)
      return turn === undefined ? entries : [...entries, turnEndedEntry(turn)]
    }),
  )
}
