import type { Event } from '../events/envelope'
import type { ThreadId } from '../events/ids'
import { rowsOwnedBy } from '../events/ownership'
import { EAgentStatus } from './status'

export type RosteredAgent = {
  agentId: ThreadId
  agentType: string
  intent: string
  status: EAgentStatus
  turns: number
  toolCalls: number
  prose: string
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
      spawnedAt: held.get(event.agentId)?.spawnedAt,
      endedAt: event.at,
    })
  }

  return [...held.values()]
}
