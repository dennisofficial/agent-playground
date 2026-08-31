import type { AssistantPart, EventDraft } from '../events/body'
import type { Event, EventOfType } from '../events/envelope'
import type { ThreadId } from '../events/ids'
import { rowsOwnedBy } from '../events/ownership'
import { eventsOfType } from '../events/projections'
import { EKilledBy } from '../shells/status'
import { EAgentStatus } from './status'

export type RosteredAgent = {
  agentId: ThreadId
  agentType: string
  intent: string
  status: EAgentStatus
  turns: number
  toolCalls: number
  prose: string
  killedBy: EKilledBy | undefined
  spawnedAt: string | undefined
  endedAt: string | undefined
}

/**
 * A spawn with no ending behind it means the process died while the child was stepping: a clean
 * quit records an ending for every live child, so the absence of one is a crash or a kill, and
 * nothing is left stepping it either way.
 */
export function agentRoster({
  events,
  threadId,
}: {
  events: readonly Event[]
  threadId: ThreadId
}): readonly RosteredAgent[] {
  const held = new Map<ThreadId, RosteredAgent>()

  for (const event of rowsOwnedBy({ events, threadId })) {
    if (event.type === 'agent-spawned') {
      held.set(event.agentId, {
        agentId: event.agentId,
        agentType: event.agentType,
        intent: event.intent,
        status: EAgentStatus.Stopped,
        turns: 0,
        toolCalls: 0,
        prose: '',
        killedBy: undefined,
        spawnedAt: event.at,
        endedAt: undefined,
      })
      continue
    }

    if (event.type !== 'agent-ended') continue

    held.set(event.agentId, {
      agentId: event.agentId,
      agentType: event.agentType,
      intent: event.intent,
      status: event.status === EAgentStatus.Running ? EAgentStatus.Stopped : event.status,
      turns: event.turns,
      toolCalls: event.toolCalls,
      prose: event.prose,
      killedBy: event.killedBy,
      spawnedAt: held.get(event.agentId)?.spawnedAt,
      endedAt: event.at,
    })
  }

  return [...held.values()]
}

export function unendedSpawns(events: readonly Event[]): readonly EventOfType<'agent-spawned'>[] {
  const ended = new Set(eventsOfType({ events, type: 'agent-ended' }).map((event) => event.agentId))

  return eventsOfType({ events, type: 'agent-spawned' }).filter(
    (event) => !ended.has(event.agentId),
  )
}

export const isLost = (agent: Pick<RosteredAgent, 'endedAt'>): boolean =>
  agent.endedAt === undefined

export type AgentProgress = { turns: number; toolCalls: number; prose: string }

const spokenText = (parts: readonly AssistantPart[]): string =>
  parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()

export function agentProgress(drafts: readonly EventDraft[]): AgentProgress {
  let turns = 0
  let toolCalls = 0
  let prose = ''

  for (const draft of drafts) {
    if (draft.type === 'tool-called') {
      toolCalls += 1
      continue
    }
    if (draft.type !== 'assistant-said') continue

    turns += 1
    const said = spokenText(draft.parts)
    if (said !== '') prose = said
  }

  return { turns, toolCalls, prose }
}

export function lostAgentEnding({
  agent,
  progress,
}: {
  agent: Pick<RosteredAgent, 'agentId' | 'agentType' | 'intent'>
  progress: AgentProgress
}): EventDraft {
  return {
    type: 'agent-ended',
    agentId: agent.agentId,
    agentType: agent.agentType,
    intent: agent.intent,
    status: EAgentStatus.Stopped,
    killedBy: EKilledBy.Unrecorded,
    prose: progress.prose,
    turns: progress.turns,
    toolCalls: progress.toolCalls,
  }
}
