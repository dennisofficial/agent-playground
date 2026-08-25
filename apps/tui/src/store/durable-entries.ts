import type { AssistantPart, Event, EventOfType } from '@dltech/atlas-core'

import { EAuthor, EEntryKind, type TranscriptEntry } from './transcript-model'

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
  const runs = runsOfParts(event.parts)

  return runs.map((run, index) => {
    const shared = {
      author: EAuthor.Model,
      key: `${event.id}#${index}`,
      text: run.text,
      streaming: false,
      interrupted: event.interrupted === true && index === runs.length - 1,
    } as const

    return run.type === 'reasoning'
      ? { kind: EEntryKind.ModelThought, ...shared }
      : { kind: EEntryKind.ModelSaid, ...shared }
  })
}

export function durableEntries(events: readonly Event[]): TranscriptEntry[] {
  return events.flatMap((event) => {
    if (event.type === 'user-said') {
      return [{ kind: EEntryKind.OperatorSaid, author: EAuthor.Operator, key: event.id, text: event.text }]
    }

    if (event.type === 'assistant-said') return entriesOfAssistantEvent(event)

    return []
  })
}
