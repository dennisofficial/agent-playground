import {
  EMessageOrigin,
  type AssemblyPipeline,
  type EventDraft,
  type EventLogPort,
  type ModelPort,
  type ThreadId,
} from '@dltech/atlas-core'

import type { HookChain } from '../../hooks/registry'
import { LoopTurnRunner, type TurnDeps } from '../../loop/run-turn'
import type { TurnRunner } from '../../loop/turn-runner.port'
import { HookedToolDispatcher } from '../../tools/dispatch'
import { filteredToolRegistry, type ToolRegistry } from '../../tools/registry'
import { AGENT_TOOL_NAMES, toolRegistryFor, type AgentType } from '../types'

export type ChildRunnerDeps = {
  turn: Omit<TurnDeps, 'drainPending'>
  tools: ToolRegistry
  hooks: HookChain
  assemblyFor: (args: { agentType: AgentType }) => AssemblyPipeline
  drainNotices: (args: { threadId: ThreadId }) => Promise<readonly EventDraft[]>
  modelFor?: ((args: { agentType: AgentType }) => ModelPort) | undefined
}

/**
 * tsyringe resolves constructor dependencies eagerly, and `agent_spawn` is a ToolDefinition the
 * ToolRegistry constructs, so resolving a child's tools while building the supervisor closes a
 * cycle. Nothing here is resolved until a spawn calls it.
 */
export type ChildRunnerDepsSource = () => ChildRunnerDeps

const withoutAgentTools = (registry: ToolRegistry): ToolRegistry =>
  filteredToolRegistry({ registry, deny: AGENT_TOOL_NAMES })

function observingLog({
  log,
  threadId,
  observe,
}: {
  log: EventLogPort
  threadId: ThreadId
  observe: (drafts: readonly EventDraft[]) => void
}): EventLogPort {
  return {
    async append(args) {
      if (args.threadId === threadId) observe(args.drafts)
      return log.append(args)
    },

    read: (args) => log.read(args),
    head: (args) => log.head(args),
    readOwn: (args) => log.readOwn(args),
  }
}

export type ChildRunnerSource = (args: ChildRunnerRequest) => TurnRunner

export type ChildRunnerRequest = {
  agentType: AgentType
  threadId: ThreadId
  observe: (drafts: readonly EventDraft[]) => void
  steering: () => readonly string[]
}

export function childRunnerSource({ deps }: { deps: ChildRunnerDepsSource }): ChildRunnerSource {
  let resolved: ChildRunnerDeps | undefined

  return (request) => {
    const held = resolved ?? deps()
    resolved = held
    return buildChildRunner({ ...request, deps: held })
  }
}

export const steerDrafts = (texts: readonly string[]): readonly EventDraft[] =>
  texts.map((text) => ({ type: 'user-said', text, via: EMessageOrigin.ParentAgent }))

export function buildChildRunner({
  deps,
  agentType,
  threadId,
  observe,
  steering,
}: ChildRunnerRequest & { deps: ChildRunnerDeps }): TurnRunner {
  const registry = withoutAgentTools(toolRegistryFor({ registry: deps.tools, agentType }))
  const { turn } = deps

  return new LoopTurnRunner({
    ...turn,
    log: observingLog({ log: turn.log, threadId, observe }),
    model: deps.modelFor === undefined ? turn.model : deps.modelFor({ agentType }),
    tools: registry.declarations(),
    dispatch: new HookedToolDispatcher({ registry, hooks: deps.hooks }),
    assembly: deps.assemblyFor({ agentType }),
    drainPending: async (args) => [...steerDrafts(steering()), ...(await deps.drainNotices(args))],
  })
}
