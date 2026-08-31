import { z } from 'zod'

import {
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
  'Restart a sub-agent that died on an error rather than on an answer, from exactly where it stopped.',
  'Takes the agentId that agent_spawn returned.',
  'Nothing is appended to its conversation, so it resumes as though the failure had not happened; reach for agent_say instead whenever you have something to add.',
  'Use it when the ending you were handed says the agent failed, not when it finished or you stopped it.',
].join(' ')

@injectable()
export class AgentResumeTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'agent_resume'
  readonly description = description
  readonly effect = EToolEffect.Write
  readonly inputSchema = inputSchema

  constructor(@inject(AgentRegistrySourceToken) private readonly agents: AgentRegistrySource) {
    super()
  }

  protected override async run({
    input,
    threadId,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const agentId = toThreadId(input.agentId)
    const outcome = await this.agents().resume({ agentId, threadId })
    if (!outcome.ok) return outcome

    return {
      ok: true,
      output: { agentId, agentType: outcome.snapshot.agentType },
      modelText: `Agent ${agentId} is running again from where it stopped, with nothing added to its conversation. Its answer reaches you when it stops.`,
    }
  }
}
