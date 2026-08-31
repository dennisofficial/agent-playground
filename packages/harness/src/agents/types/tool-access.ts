import { filteredToolRegistry, type ToolRegistry } from '../../tools/registry'
import type { AgentType } from './agent-type'

export function toolRegistryFor(args: {
  registry: ToolRegistry
  agentType: AgentType
}): ToolRegistry {
  return filteredToolRegistry({
    registry: args.registry,
    allow: args.agentType.tools,
    deny: args.agentType.disallowedTools,
    maxEffect: args.agentType.maxEffect,
  })
}
