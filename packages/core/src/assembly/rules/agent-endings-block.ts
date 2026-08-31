import { agentLabel } from '../../agents/label'
import { agentEnding, countedNoun } from '../../agents/status'
import type { Event, EventOfType } from '../../events/envelope'
import type { AssembledMessage } from '../assembled'
import { defineRule, type Rule } from '../rule'

const OPEN = '<agents-ended>'
const CLOSE = '</agents-ended>'

export const DEFAULT_AGENT_PROSE_BUDGET = 8_000

const REPORTED_NOTHING = 'It reported nothing.'

const NOT_YOUR_HISTORY =
  'None of their own steps are in your history and none are coming: what each one reports here is all of it.'

type Ending = EventOfType<'agent-ended'>

type Portion = { event: Ending; prose: string; dropped: number }

const shortenedNote = (characters: number): string =>
  `[${characters} characters of this report were dropped: the agents that ended together share one budget.]`

const droppedWholeNote = (characters: number): string =>
  `[All ${characters} characters of this report were dropped: too many agents ended together to quote any of them.]`

function portions({
  endings,
  budget,
}: {
  endings: readonly Ending[]
  budget: number
}): readonly Portion[] {
  const trimmed = endings.map((event, index) => ({ event, index, prose: event.prose.trim() }))
  const shortestFirst = [...trimmed].sort(
    (left, right) => left.prose.length - right.prose.length || left.index - right.index,
  )

  const allotted = new Map<number, Portion>()
  let remaining = budget
  let unallotted = shortestFirst.length

  for (const entry of shortestFirst) {
    const share = Math.max(0, Math.floor(remaining / unallotted))
    const prose = entry.prose.length <= share ? entry.prose : entry.prose.slice(0, share)
    remaining -= prose.length
    unallotted -= 1
    allotted.set(entry.index, {
      event: entry.event,
      prose,
      dropped: entry.prose.length - prose.length,
    })
  }

  return trimmed.flatMap((entry) => {
    const portion = allotted.get(entry.index)
    return portion === undefined ? [] : [portion]
  })
}

function reportOf(portion: Portion): readonly string[] {
  if (portion.dropped === 0) return [portion.prose === '' ? REPORTED_NOTHING : portion.prose]
  if (portion.prose === '') return [droppedWholeNote(portion.dropped)]
  return [portion.prose, shortenedNote(portion.dropped)]
}

function sectionOf(portion: Portion): string {
  const headline = `Agent ${portion.event.agentId} ${agentLabel(portion.event)} ${agentEnding(portion.event)}.`
  return [headline, ...reportOf(portion)].join('\n\n')
}

export function agentEndingsText({
  endings,
  proseBudget = DEFAULT_AGENT_PROSE_BUDGET,
}: {
  endings: readonly Ending[]
  proseBudget?: number | undefined
}): string {
  const roster = `${countedNoun({ count: endings.length, noun: 'agent' })} you spawned ended. ${NOT_YOUR_HISTORY}`
  const sections = portions({ endings, budget: proseBudget }).map(sectionOf)

  return [OPEN, [roster, ...sections].join('\n\n'), CLOSE].join('\n')
}

function waves(events: readonly Event[]): readonly (readonly Ending[])[] {
  const grouped: Ending[][] = []
  let open: Ending[] | undefined

  for (const event of events) {
    if (event.type !== 'agent-ended') {
      open = undefined
      continue
    }

    if (open === undefined) {
      open = [event]
      grouped.push(open)
      continue
    }

    open.push(event)
  }

  return grouped
}

function mergeBySeq({
  messages,
  blocks,
}: {
  messages: readonly AssembledMessage[]
  blocks: readonly AssembledMessage[]
}): readonly AssembledMessage[] {
  const merged: AssembledMessage[] = []
  let index = 0

  for (const block of blocks) {
    while (index < messages.length) {
      const next = messages[index]
      if (next === undefined || next.origin.seq > block.origin.seq) break
      merged.push(next)
      index += 1
    }

    merged.push(block)
  }

  return [...merged, ...messages.slice(index)]
}

function blockFor({
  endings,
  proseBudget,
}: {
  endings: readonly Ending[]
  proseBudget: number
}): readonly AssembledMessage[] {
  const anchor = endings[endings.length - 1]
  if (anchor === undefined) return []

  return [
    {
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: agentEndingsText({ endings, proseBudget }) }],
      },
      origin: { eventId: anchor.id, seq: anchor.seq },
    },
  ]
}

export function agentEndingsBlock({
  proseBudget = DEFAULT_AGENT_PROSE_BUDGET,
}: { proseBudget?: number | undefined } = {}): Rule {
  return defineRule({
    name: 'agentEndingsBlock',
    apply: (input, ctx) => {
      const grouped = waves(ctx.events)
      if (grouped.length === 0) return input

      const blocks = grouped.flatMap((endings) => blockFor({ endings, proseBudget }))

      return { system: input.system, messages: mergeBySeq({ messages: input.messages, blocks }) }
    },
  })
}
