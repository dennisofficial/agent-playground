import { EAgentStatus, type ThreadId } from '@dltech/atlas-core'

import { ETurnStatus, type TurnOutcome } from '../../loop/turn-outcome'
import type { AgentType } from '../types'
import type { AgentSnapshot } from './snapshot'

export const EMPTY_BRIEF = 'a sub-agent reads nothing but its brief, so it cannot be empty'

export const statusOf = (outcome: TurnOutcome): EAgentStatus => {
  if (outcome.status === ETurnStatus.Failed) return EAgentStatus.Failed
  if (outcome.status === ETurnStatus.Interrupted) return EAgentStatus.Stopped
  if (outcome.status === ETurnStatus.Paused) return EAgentStatus.Blocked
  return EAgentStatus.Finished
}

export function unknownAgentType({
  agentType,
  known,
}: {
  agentType: string
  known: readonly AgentType[]
}): string {
  const names = known.length === 0 ? 'none is registered' : known.map((one) => one.name).join(', ')
  return `no agent type named "${agentType}" is registered; known types: ${names}`
}

export function unknownAgent({
  agentId,
  known,
}: {
  agentId: ThreadId
  known: readonly AgentSnapshot[]
}): string {
  const ids = known.length === 0 ? 'none is running' : known.map((one) => one.agentId).join(', ')
  return `you have no sub-agent registered as "${agentId}"; your agents: ${ids}`
}

export const retiredAgentType = (agentType: string): string =>
  `agent type "${agentType}" is no longer defined, so this agent cannot take another step`

export const alreadyStepping = (agentId: ThreadId): string =>
  `agent ${agentId} is already taking a step; steer it with a message or stop it first`
