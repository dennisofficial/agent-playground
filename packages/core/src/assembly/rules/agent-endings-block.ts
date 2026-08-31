import { agentLabel } from '../../agents/label'
import { agentEnding, countedNoun } from '../../agents/status'
import type { Event, EventOfType } from '../../events/envelope'
import { EKilledBy } from '../../shells/status'
import type { AssembledMessage } from '../assembled'
import { defineRule, type Rule } from '../rule'

const OPEN = '<agents-ended>'
const CLOSE = '</agents-ended>'

const REPORTED_NOTHING = 'It reported nothing.'

const USER_STOPPED =
  'The user stopped this agent deliberately; you did not, and nothing went wrong with it. Do not spawn it again to finish what it was doing unless the user asks.'

const LOST_AGENT =
  'Nobody stopped this agent: the session it was running in went away before it could report. What it says here is only what it had said by then, and whatever it was doing may be half-applied. Its thread is intact, so check the work before redoing any of it, and let the user decide whether to resume it.'

const NOT_YOUR_HISTORY =
  'None of their own steps are in your history and none are coming: what each one reports here is all of it.'

type Ending = EventOfType<'agent-ended'>

const reportOf = (event: Ending): string => {
  const prose = event.prose.trim()
  return prose === '' ? REPORTED_NOTHING : prose
}

function advice(event: Ending): readonly string[] {
  if (event.killedBy === EKilledBy.User) return [USER_STOPPED]
  if (event.killedBy === EKilledBy.Unrecorded) return [LOST_AGENT]
  return []
}

function sectionOf(event: Ending): string {
  const headline = `Agent ${event.agentId} ${agentLabel(event)} ${agentEnding(event)}.`
  return [headline, ...advice(event), reportOf(event)].join('\n\n')
}

export function agentEndingsText({ endings }: { endings: readonly Ending[] }): string {
  const roster = `${countedNoun({ count: endings.length, noun: 'agent' })} you spawned ended. ${NOT_YOUR_HISTORY}`

  return [OPEN, [roster, ...endings.map(sectionOf)].join('\n\n'), CLOSE].join('\n')
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

function blockFor({ endings }: { endings: readonly Ending[] }): readonly AssembledMessage[] {
  const anchor = endings[endings.length - 1]
  if (anchor === undefined) return []

  return [
    {
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: agentEndingsText({ endings }) }],
      },
      origin: { eventId: anchor.id, seq: anchor.seq },
    },
  ]
}

export function agentEndingsBlock(): Rule {
  return defineRule({
    name: 'agentEndingsBlock',
    apply: (input, ctx) => {
      const grouped = waves(ctx.events)
      if (grouped.length === 0) return input

      const blocks = grouped.flatMap((endings) => blockFor({ endings }))

      return { system: input.system, messages: mergeBySeq({ messages: input.messages, blocks }) }
    },
  })
}
