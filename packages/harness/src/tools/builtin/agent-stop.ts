import { z } from 'zod'

import {
  agentEnding,
  EAgentStatus,
  EKilledBy,
  EToolEffect,
  SchemaTool,
  toThreadId,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import { inject, injectable } from '../../container/injection'
import { AgentRegistrySourceToken, type AgentRegistrySource } from './agent-tokens'

const inputSchema = z.strictObject({
  agentId: z.string().min(1),
})

const description = [
  'Interrupt a sub-agent you started, before it has finished.',
  'Takes the agentId that agent_spawn returned.',
  'It stops after the step it is taking, and you are handed how it ended and whatever it had said, the same as any other ending.',
  'Its work up to that point is kept, so an agent you stopped can be sent on with agent_say.',
  'Reach for it when the task is no longer wanted or the agent is going somewhere useless; steer it with agent_say when it is still worth finishing.',
].join(' ')

@injectable()
export class AgentStopTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'agent_stop'
  readonly description = description
  readonly effect = EToolEffect.Destructive
  readonly inputSchema = inputSchema

  constructor(@inject(AgentRegistrySourceToken) private readonly agents: AgentRegistrySource) {
    super()
  }

  protected override async run({
    input,
    threadId,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const agentId = toThreadId(input.agentId)
    const outcome = this.agents().stop({ agentId, threadId, by: EKilledBy.Model })
    if (!outcome.ok) return outcome

    const { snapshot } = outcome
    const alreadyOver = snapshot.status !== EAgentStatus.Running

    return {
      ok: true,
      output: {
        agentId: snapshot.agentId,
        agentType: snapshot.agentType,
        status: snapshot.status,
        ...(alreadyOver ? { killedBy: snapshot.killedBy } : { stopRequestedBy: EKilledBy.Model }),
      },
      modelText: alreadyOver
        ? `Agent ${agentId} ${agentEnding(snapshot)}, so nothing was interrupted.`
        : `Signalled agent ${agentId} to stop. It ends after the step it is taking, and you will be handed how it ended.`,
    }
  }
}
