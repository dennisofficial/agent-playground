import { EAgentStatus, type ThreadId } from '@dltech/atlas-core'
import type { AgentSnapshot } from '@dltech/atlas-harness'

import { ESubagentReading, subagentReading } from '../../store/subagent-row'

export type AgentChoice = {
  agentId: ThreadId
  name: string
  state: string
  tone: ESubagentReading
}

const UNTITLED = 'an untitled sub-agent'

const NOT_YET_STARTED = 0

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const AGENT_STATE_LABEL: Record<EAgentStatus, string> = {
  [EAgentStatus.Running]: 'running',
  [EAgentStatus.Blocked]: 'blocked',
  [EAgentStatus.Finished]: 'done',
  [EAgentStatus.Failed]: 'failed',
  [EAgentStatus.Stopped]: 'stopped',
}

export const agentHasSettled = (agent: Pick<AgentSnapshot, 'status'>): boolean =>
  subagentReading(agent) === ESubagentReading.Settled

export const agentStateLabel = (agent: Pick<AgentSnapshot, 'status'>): string =>
  AGENT_STATE_LABEL[agent.status]

export function agentChoiceName(agent: Pick<AgentSnapshot, 'intent' | 'agentType'>): string {
  const intent = oneLine(agent.intent)
  if (intent !== '') return intent

  const typed = oneLine(agent.agentType)
  return typed === '' ? UNTITLED : typed
}

const lastHeardFrom = (agent: AgentSnapshot): number => {
  const at = Date.parse(agent.endedAt ?? agent.startedAt)
  return Number.isNaN(at) ? NOT_YET_STARTED : at
}

const choiceOf = (agent: AgentSnapshot): AgentChoice => ({
  agentId: agent.agentId,
  name: agentChoiceName(agent),
  state: agentStateLabel(agent),
  tone: subagentReading(agent),
})

export function agentChoices({
  agents,
}: {
  agents: readonly AgentSnapshot[]
}): readonly AgentChoice[] {
  return [...agents]
    .sort((left, right) => {
      const settled = Number(agentHasSettled(left)) - Number(agentHasSettled(right))
      if (settled !== 0) return settled

      return lastHeardFrom(right) - lastHeardFrom(left)
    })
    .map(choiceOf)
}
