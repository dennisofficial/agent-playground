import { z } from 'zod'

import {
  agentEnding,
  EAgentStatus,
  EToolEffect,
  SchemaTool,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import type { AgentSnapshot } from '../../agents/registry/snapshot'
import { inject, injectable } from '../../container/injection'
import { AgentRegistrySourceToken, type AgentRegistrySource } from './agent-tokens'

const inputSchema = z.strictObject({})

const description = [
  'List the sub-agents you have started, running and stopped alike.',
  'Each entry names its agentId, its type and the intent you gave it, plus how it ended and how much work that took for the ones that have.',
  'You see only your own sub-agents: another agent cannot see them, and you cannot see another agent’s.',
  'A running sub-agent hands you its report by itself the moment it stops, and one that has stopped has already handed you its answer, so this is not how you find out whether one has finished and it will never carry a result.',
  'Reach for it when you have lost track of which agents you have out, never to watch one work.',
].join(' ')

const STILL_RUNNING = 'is still running'

export function lineFor(snapshot: AgentSnapshot): string {
  const named = `${snapshot.agentId}  ${snapshot.agentType}  ${snapshot.intent}`

  if (snapshot.status === EAgentStatus.Running) return `${named}  ${STILL_RUNNING}`

  const ending = agentEnding({
    status: snapshot.status,
    turns: snapshot.turns,
    toolCalls: snapshot.toolCalls,
  })
  const lastTool = snapshot.lastTool === undefined ? '' : `, last tool ${snapshot.lastTool}`

  return `${named}  ${ending}${lastTool}`
}

@injectable()
export class AgentListTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'agent_list'
  readonly description = description
  readonly effect = EToolEffect.Read
  readonly inputSchema = inputSchema
  override readonly isConcurrencySafe = (): boolean => true

  constructor(@inject(AgentRegistrySourceToken) private readonly agents: AgentRegistrySource) {
    super()
  }

  protected override async run({ threadId }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const mine = this.agents().list({ threadId })

    if (mine.length === 0) {
      return { ok: true, output: { agents: [] }, modelText: 'You have started no sub-agents.' }
    }

    return {
      ok: true,
      output: {
        agents: mine.map((snapshot) => ({
          agentId: snapshot.agentId,
          agentType: snapshot.agentType,
          intent: snapshot.intent,
          status: snapshot.status,
          turns: snapshot.turns,
          toolCalls: snapshot.toolCalls,
          lastTool: snapshot.lastTool,
          startedAt: snapshot.startedAt,
          endedAt: snapshot.endedAt,
        })),
      },
      modelText: mine.map(lineFor).join('\n'),
    }
  }
}
