import type { DependencyContainer, InjectionToken } from '../../container/injection'
import { AgentTypesToken } from '../../tools/builtin/agent-tokens'
import type { AgentTypeSource } from './agent-type'
import { loadAgentTypes, type AgentTypeCatalog, type ModelIsUsable } from './registry'

export const AgentTypeCatalogToken: InjectionToken<AgentTypeCatalog> =
  Symbol('atlas.AgentTypeCatalog')

export class AgentTypesNotBound extends Error {
  constructor() {
    super(
      'the agent type binding did not take, so the built-in-only list the container ships with is still in place',
    )
  }
}

export async function bindAgentTypes(args: {
  container: DependencyContainer
  sources: readonly AgentTypeSource[]
  reachableModelIds?: readonly string[] | undefined
  modelIsUsable?: ModelIsUsable | undefined
  subagentModelId?: string | undefined
}): Promise<AgentTypeCatalog> {
  const catalog = await loadAgentTypes({
    sources: args.sources,
    reachableModelIds: args.reachableModelIds,
    modelIsUsable: args.modelIsUsable,
    subagentModelId: args.subagentModelId,
  })

  args.container.register(AgentTypesToken, { useValue: catalog.types })
  args.container.register(AgentTypeCatalogToken, { useValue: catalog })

  if (args.container.resolve(AgentTypesToken) !== catalog.types) throw new AgentTypesNotBound()

  return catalog
}
