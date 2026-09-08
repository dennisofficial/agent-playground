import { EContextSlot, latestTldrPerAnchor, quotedShellCommand, type AssistantPart, type CallId, type Event, type EventId, type EventOfType, type SaidImage } from '@dltech/atlas-core'

import { formatElapsed } from '../ui/theme'


import { agentEndedLine, agentEndingFailed } from './agent-ended-line'
import { injectedContextBlocks } from './injected-context'
import { modelEntries } from './model-entries'
import { serviceEndedLine, serviceEndingFailed } from './service-ended-line'
import { shellAwaitingInputLine, shellEndedLine, shellEndingFailed } from './shell-ended-line'
import { toolRuns, type ToolRun } from './tool-runs'
import type { TurnSpend } from '@dltech/atlas-harness'
import { EAuthor, EEntryKind, toolsRanEntry, type TranscriptEntry } from './transcript-model'
import { turnEndedEntry, turnsBySeq } from './turn-rows'

const shellName = (shell: { command: string; description?: string | undefined }): string => {
  const description = shell.description?.trim() ?? ''
  return description === '' ? quotedShellCommand(shell.command) : `"${description}"`
}

const matchedLineCount = (count: number): string => (count === 1 ? '1 line' : `${count} lines`)

const shellMatchedLine = (event: EventOfType<'background-shell-matched'>): string => {
  const named = shellName(event)
  const matched = `matched ${matchedLineCount(event.matchCount)} and is still running`
  return event.watchDisarmed === true
    ? `Background shell ${named} ${matched}, but stopped watching`
    : `Background shell ${named} ${matched}`
}

const shellStillRunningEntryLine = (
  event: EventOfType<'background-shell-still-running'>,
): string =>
  `Background shell ${shellName(event)} is still running after ${formatElapsed(event.runningForMs)} - a scheduled check-in, not an ending`

type PartRun = { type: AssistantPart['type']; text: string }

function runsOfParts(parts: readonly AssistantPart[]): PartRun[] {
  const runs: PartRun[] = []

  for (const part of parts) {
    const open = runs.at(-1)
    if (open?.type === part.type) {
      open.text += part.text
      continue
    }

    runs.push({ type: part.type, text: part.text })
  }

  return runs
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

type AttachedContext = { skills: readonly string[]; files: readonly string[] }

const NOTHING_ATTACHED: AttachedContext = { skills: [], files: [] }

function contextLoadedWith(events: readonly Event[]): ReadonlyMap<EventId, AttachedContext> {
  const attached = new Map<EventId, AttachedContext>()
  let skills: string[] = []
  let files: string[] = []

  for (const event of events) {
    if (event.type === 'context-loaded') {
      if (event.slot === EContextSlot.Skill) skills.push(event.key)
      if (event.slot === EContextSlot.File) files.push(event.key)
      continue
    }

    if (event.type === 'user-said' && skills.length + files.length > 0) {
      attached.set(event.id, { skills, files })
    }
    skills = []
    files = []
  }

  return attached
}

const NOTHING_PICTURED: readonly SaidImage[] = Object.freeze([])

function inOneBreath(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const folded: TranscriptEntry[] = []

  for (const entry of entries) {
    const open = folded.at(-1)
    if (
      entry.kind !== EEntryKind.OperatorSaid ||
      open?.kind !== EEntryKind.OperatorSaid ||
      open.steer !== entry.steer
    ) {
      folded.push(entry)
      continue
    }

    folded[folded.length - 1] = {
      ...open,
      text: `${open.text}\n${entry.text}`,
      said: [...open.said, ...entry.said],
      skills: [...new Set([...open.skills, ...entry.skills])],
      files: [...new Set([...open.files, ...entry.files])],
      images: [...open.images, ...entry.images],
    }
  }

  return folded
}

export function durableEntries(args: {
  events: readonly Event[]
  turns?: readonly TurnSpend[] | undefined
}): TranscriptEntry[] {
  const { events } = args
  const opened = new Map<string, ToolRun>(toolRuns(events).map((run) => [run.openedBy, run]))
  const steers = saidWhileToolsWereOutstanding(events)
  const loaded = contextLoadedWith(events)
  const injected = injectedContextBlocks(events)
  const turns = turnsBySeq({ events, turns: args.turns ?? [] })
  const footers = new Map(latestTldrPerAnchor(events).map((footer) => [footer.throughSeq, footer]))

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
          skills: (loaded.get(event.id) ?? NOTHING_ATTACHED).skills,
          files: (loaded.get(event.id) ?? NOTHING_ATTACHED).files,
          images: event.images ?? NOTHING_PICTURED,
        },
      ]
    }

    if (event.type === 'context-loaded') {
      const block = injected.heads.get(event.id)
      return block === undefined ? [] : [block]
    }

    if (event.type === 'assistant-said') return entriesOfAssistantEvent(event)

    if (event.type === 'tool-called') {
      const run = opened.get(event.callId)
      return run === undefined ? [] : [toolsRanEntry(run)]
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

    if (event.type === 'background-shell-awaiting-input') {
      return [
        {
          kind: EEntryKind.BackgroundShellAwaitingInput,
          author: EAuthor.Model,
          key: event.id,
          text: shellAwaitingInputLine(event),
          shellId: event.shellId,
          output: event.output,
        },
      ]
    }

    if (event.type === 'background-shell-matched') {
      return [
        {
          kind: EEntryKind.BackgroundShellMatched,
          author: EAuthor.Model,
          key: event.id,
          text: shellMatchedLine(event),
          shellId: event.shellId,
          output: event.lines,
        },
      ]
    }

    if (event.type === 'background-shell-still-running') {
      return [
        {
          kind: EEntryKind.BackgroundShellStillRunning,
          author: EAuthor.Model,
          key: event.id,
          text: shellStillRunningEntryLine(event),
          shellId: event.shellId,
          output: event.tail,
        },
      ]
    }

    if (event.type === 'service-ended') {
      return [
        {
          kind: EEntryKind.ServiceEnded,
          author: EAuthor.Model,
          key: event.id,
          text: serviceEndedLine(event),
          serviceId: event.serviceId,
          output: event.tail,
          failed: serviceEndingFailed(event),
        },
      ]
    }

    if (event.type === 'agent-ended') {
      return [
        {
          kind: EEntryKind.AgentEnded,
          author: EAuthor.Model,
          key: event.id,
          text: agentEndedLine(event),
          agentId: event.agentId,
          report: event.prose,
          failed: agentEndingFailed(event),
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
      const footer = footers.get(event.seq)
      const withFooter =
        footer === undefined
          ? entries
          : [
              ...entries,
              {
                kind: EEntryKind.TldrWritten as const,
                author: EAuthor.Model as const,
                key: footer.id,
                text: footer.text,
                anchorSeq: footer.anchorSeq,
                throughSeq: footer.throughSeq,
                status: footer.status,
              },
            ]
      const turn = turns.get(event.seq)
      return turn === undefined ? withFooter : [...withFooter, turnEndedEntry(turn)]
    }),
  )
}
