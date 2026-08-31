import { z } from 'zod'

import {
  countedNoun,
  EToolEffect,
  SchemaTool,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import type { AgentSnapshot } from '../../agents/registry/snapshot'
import { AGENT_SPAWN_TOOL_NAME, type AgentType } from '../../agents/types/agent-type'
import { inject, injectable } from '../../container/injection'
import { AgentRegistrySourceToken, AgentTypesToken, type AgentRegistrySource } from './agent-tokens'

const oneAgent = z.strictObject({
  agentType: z.string().min(1),
  intent: z.string().min(1),
  brief: z.string().min(1),
})

const inputSchema = z.strictObject({
  agentType: z.string().min(1).optional(),
  intent: z.string().min(1).optional(),
  brief: z.string().min(1).optional(),
  agents: z.array(oneAgent).min(1).optional(),
})

type SpawnRequest = z.output<typeof oneAgent>

const BOTH_FORMS =
  'pass either one agent as agentType, intent and brief, or a wave as agents, not both'

const INCOMPLETE =
  'a spawn needs all three of agentType, intent and brief, or an agents array of entries that each carry all three'

const PROSE = [
  'Start a sub-agent: a second agent with its own conversation and its own context window, working on one task you hand it.',
  'It has the same tools you have and cannot spawn sub-agents of its own.',
  'It runs in the background, so this returns its agentId at once and its answer reaches you on its own when it stops; never poll for it.',
  'brief is the whole of what it will ever know about the task, because it does not read your conversation: state the goal, the files and facts it needs, and what to report back.',
  'intent is one short line naming what it is doing, which is how you and the person watching tell your agents apart.',
  'Delegate work that is worth a fresh context window — a search across many files, a self-contained change, a review — and keep work you are already holding the context for.',
  'Fan out by emitting several calls in one turn, or by passing agents with one entry each; they run at the same time.',
].join(' ')

function typeListing(types: readonly AgentType[]): string {
  if (types.length === 0) return 'No agent type is registered, so nothing can be spawned yet.'

  return [
    'The types you may pass as agentType:',
    ...types.map((type) => `- ${type.name}: ${type.whenToUse}`),
  ].join('\n')
}

export const describeSpawn = (types: readonly AgentType[]): string =>
  [PROSE, typeListing(types)].join('\n\n')

function requestedSpawns(
  input: z.output<typeof inputSchema>,
): { ok: true; requests: readonly SpawnRequest[] } | { ok: false; reason: string } {
  const single =
    input.agentType !== undefined || input.intent !== undefined || input.brief !== undefined

  if (input.agents !== undefined) {
    return single ? { ok: false, reason: BOTH_FORMS } : { ok: true, requests: input.agents }
  }

  if (input.agentType === undefined || input.intent === undefined || input.brief === undefined) {
    return { ok: false, reason: INCOMPLETE }
  }

  return {
    ok: true,
    requests: [{ agentType: input.agentType, intent: input.intent, brief: input.brief }],
  }
}

const lineFor = (snapshot: AgentSnapshot): string =>
  `${snapshot.agentId}  ${snapshot.agentType}  ${snapshot.intent}`

@injectable()
export class AgentSpawnTool extends SchemaTool<typeof inputSchema> {
  readonly name = AGENT_SPAWN_TOOL_NAME
  readonly description: string
  readonly effect = EToolEffect.Write
  readonly inputSchema = inputSchema
  override readonly isConcurrencySafe = (): boolean => true

  constructor(
    @inject(AgentRegistrySourceToken) private readonly agents: AgentRegistrySource,
    @inject(AgentTypesToken) types: readonly AgentType[],
  ) {
    super()
    this.description = describeSpawn(types)
  }

  protected override async run({
    input,
    threadId,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const requested = requestedSpawns(input)
    if (!requested.ok) return requested

    const registry = this.agents()
    const outcomes = await Promise.all(
      requested.requests.map((request) => registry.spawn({ threadId, ...request })),
    )

    const started: AgentSnapshot[] = []
    const refused: string[] = []
    for (const outcome of outcomes) {
      if (outcome.ok) started.push(outcome.snapshot)
      else refused.push(outcome.reason)
    }

    if (started.length === 0) return { ok: false, reason: refused.join('; ') }

    return {
      ok: true,
      output: {
        agents: started.map((snapshot) => ({
          agentId: snapshot.agentId,
          agentType: snapshot.agentType,
          intent: snapshot.intent,
        })),
      },
      modelText: [
        `Started ${countedNoun({ count: started.length, noun: 'sub-agent' })}.`,
        ...started.map(lineFor),
        'They run in the background, and each one hands you its answer the moment it stops.',
        ...refused,
      ].join('\n'),
    }
  }
}
