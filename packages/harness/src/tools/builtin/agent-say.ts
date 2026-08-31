import { z } from 'zod'

import {
  EAgentStatus,
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
  text: z.string().min(1),
})

const description = [
  'Send a message to a sub-agent you started, whether it is still running or has already stopped.',
  'Takes the agentId that agent_spawn returned.',
  'A running agent reads it before its next step, so this is how you correct a delegate that is going the wrong way without killing its work.',
  'A stopped agent starts running again on it, so this is how you ask for more after it has answered you.',
  'It is the only thing you can say to a sub-agent: it never asks you a question and it cannot be interrupted mid-step.',
].join(' ')

@injectable()
export class AgentSayTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'agent_say'
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
    const registry = this.agents()
    const before = registry
      .list({ threadId })
      .find((snapshot) => snapshot.agentId === agentId)?.status

    const outcome = await registry.say({ agentId, threadId, text: input.text })
    if (!outcome.ok) return outcome

    const queued = before === EAgentStatus.Running

    return {
      ok: true,
      output: { agentId, queued },
      modelText: queued
        ? `Agent ${agentId} is mid-step, so your message is queued and it will read it before its next one.`
        : `Agent ${agentId} took your message and is running again; its answer reaches you when it stops.`,
    }
  }
}
