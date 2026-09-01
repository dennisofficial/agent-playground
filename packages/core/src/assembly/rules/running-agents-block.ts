import { agentLabel } from '../../agents/label'
import { wrapInSystemReminder } from '../../context/render'
import type { ThreadId } from '../../events/ids'
import { defineRule, type Rule } from '../rule'
import { appendedAtTail } from './tail-block'

export type RunningAgent = {
  agentId: string
  agentType: string
  intent: string
}

export type RunningAgentsSource = (args: { threadId: ThreadId }) => readonly RunningAgent[]

const HOW_TO_WAIT = [
  'Each one outlives this turn and hands you its report by itself, wherever you are, so never poll to find out whether one has finished: agent_list can tell you nothing about these that is not already written here.',
  'Ending your turn is how you wait — a sub-agent that ends while nothing is running opens a turn of its own to deliver what it found.',
  'So if you have work that does not depend on them, do that work; if you are only waiting, say what you are waiting for and end your turn, rather than saying it and taking another step.',
  'Steer one with agent_say({ agentId, text }) and end one early with agent_stop({ agentId }).',
].join(' ')

const lineFor = (agent: RunningAgent): string => `${agent.agentId}  ${agentLabel(agent)}`

export function runningAgentsReminder(agents: readonly RunningAgent[]): string {
  return wrapInSystemReminder(
    [
      'These sub-agents you spawned are still running:',
      agents.map(lineFor).join('\n'),
      HOW_TO_WAIT,
    ].join('\n\n'),
  )
}

export function runningAgentsBlock({
  runningAgents,
}: {
  runningAgents: RunningAgentsSource
}): Rule {
  return defineRule({
    name: 'runningAgentsBlock',
    apply: (input, ctx) => {
      const agents = runningAgents({ threadId: ctx.threadId })
      if (agents.length === 0) return input

      return appendedAtTail({ input, ctx, text: runningAgentsReminder(agents) })
    },
  })
}
