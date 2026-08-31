import {
  MODEL_CATALOG,
  modelEntry,
  resolveShadowing,
  type EDefinitionOrigin,
} from '@dltech/atlas-core'

import {
  AGENT_SPAWN_TOOL_NAME,
  EAgentTypeRefusal,
  type AgentType,
  type AgentTypeRefusal,
  type AgentTypeSource,
} from './agent-type'

export type ModelIsUsable = (modelId: string) => boolean

export type ShadowedAgentType = {
  name: string
  origin: EDefinitionOrigin
  definedIn: string | undefined
  shadowedBy: EDefinitionOrigin
}

export type AgentTypeCatalog = {
  types: readonly AgentType[]
  refusals: readonly AgentTypeRefusal[]
  shadowed: readonly ShadowedAgentType[]
}

export const EMPTY_AGENT_TYPE_CATALOG: AgentTypeCatalog = {
  types: [],
  refusals: [],
  shadowed: [],
}

const inCatalog: ModelIsUsable = (modelId) => modelEntry(modelId) !== undefined

const withoutSelfSpawn = (agentType: AgentType): AgentType => ({
  ...agentType,
  tools: agentType.tools?.filter((tool) => tool !== AGENT_SPAWN_TOOL_NAME),
  disallowedTools: [...new Set([...(agentType.disallowedTools ?? []), AGENT_SPAWN_TOOL_NAME])],
})

const reachableModels = (isUsable: ModelIsUsable): readonly string[] =>
  MODEL_CATALOG.filter((entry) => isUsable(entry.id)).map((entry) => entry.id)

function unusableModelDetail(args: { modelId: string; isUsable: ModelIsUsable }): string {
  const reachable = reachableModels(args.isUsable)

  return [
    `model: "${args.modelId}" is not a model this build can run an agent on.`,
    reachable.length === 0
      ? 'No model is reachable, so pin none.'
      : `Pin one of: ${reachable.join(', ')}.`,
  ].join(' ')
}

function unusableSubagentModelDetail(args: { modelId: string; isUsable: ModelIsUsable }): string {
  const reachable = reachableModels(args.isUsable)

  return [
    `ATLAS_SUBAGENT_MODEL="${args.modelId}" is not a model this build can run an agent on,`,
    'and this agent type pins none of its own.',
    reachable.length === 0
      ? 'No model is reachable, so unset it and let a child inherit the parent model.'
      : `Set it to one of: ${reachable.join(', ')}, or unset it to let a child inherit the parent model.`,
  ].join(' ')
}

function modelRefusal(args: {
  agentType: AgentType
  isUsable: ModelIsUsable
  subagentModelId: string | undefined
}): AgentTypeRefusal | undefined {
  const pinned = args.agentType.model
  const modelId = pinned ?? args.subagentModelId
  if (modelId === undefined || args.isUsable(modelId)) return undefined

  return {
    refusal: EAgentTypeRefusal.UnusableModel,
    name: args.agentType.name,
    definedIn: args.agentType.definedIn,
    origin: args.agentType.origin,
    detail:
      pinned === undefined
        ? unusableSubagentModelDetail({ modelId, isUsable: args.isUsable })
        : unusableModelDetail({ modelId, isUsable: args.isUsable }),
  }
}

function shadowedBy({
  definitions,
  winners,
}: {
  definitions: readonly AgentType[]
  winners: readonly AgentType[]
}): readonly ShadowedAgentType[] {
  const held = new Set(winners)

  return definitions.flatMap((definition) => {
    if (held.has(definition)) return []

    const winner = winners.find((one) => one.name === definition.name)
    if (winner === undefined) return []

    return [
      {
        name: definition.name,
        origin: definition.origin,
        definedIn: definition.definedIn,
        shadowedBy: winner.origin,
      },
    ]
  })
}

export async function loadAgentTypes(args: {
  sources: readonly AgentTypeSource[]
  modelIsUsable?: ModelIsUsable | undefined
  subagentModelId?: string | undefined
}): Promise<AgentTypeCatalog> {
  const isUsable = args.modelIsUsable ?? inCatalog
  const read = await Promise.all(args.sources.map((source) => source.load()))

  const refusals: AgentTypeRefusal[] = read.flatMap((entry) => [...entry.refusals])
  const usable: AgentType[] = []

  for (const agentType of read.flatMap((entry) => entry.types)) {
    const refused = modelRefusal({ agentType, isUsable, subagentModelId: args.subagentModelId })
    if (refused === undefined) usable.push(agentType)
    else refusals.push(refused)
  }

  const winners = resolveShadowing({
    definitions: usable,
    nameOf: (agentType) => agentType.name,
  })

  return {
    types: winners.map(withoutSelfSpawn),
    refusals,
    shadowed: shadowedBy({ definitions: usable, winners }),
  }
}
