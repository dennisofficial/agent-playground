import { resolveShadowing, type EDefinitionOrigin } from '@dltech/atlas-core'

import { modelsWorthOffering, offerSentence } from './model-offer'
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

const anyModelWhenNoneWereNamed = (
  reachableModelIds: readonly string[] | undefined,
): ModelIsUsable =>
  reachableModelIds === undefined ? () => true : (modelId) => reachableModelIds.includes(modelId)

const withoutSelfSpawn = (agentType: AgentType): AgentType => ({
  ...agentType,
  tools: agentType.tools?.filter((tool) => tool !== AGENT_SPAWN_TOOL_NAME),
  disallowedTools: [...new Set([...(agentType.disallowedTools ?? []), AGENT_SPAWN_TOOL_NAME])],
})

function unusableModelDetail(args: { modelId: string; reachable: readonly string[] }): string {
  return [
    `model: "${args.modelId}" is not a model this build can run an agent on.`,
    offerSentence({
      offer: modelsWorthOffering(args),
      lead: 'Pin one of:',
      whenNothingIsReachable: 'No model is reachable, so pin none.',
    }),
  ].join(' ')
}

function unusableSubagentModelDetail(args: {
  modelId: string
  reachable: readonly string[]
}): string {
  return [
    `ATLAS_SUBAGENT_MODEL="${args.modelId}" is not a model this build can run an agent on,`,
    'and this agent type pins none of its own.',
    offerSentence({
      offer: modelsWorthOffering(args),
      lead: 'Set it to one of:',
      whenNothingIsReachable:
        'No model is reachable, so unset it and let a child inherit the parent model.',
      then: 'Unset it to let a child inherit the parent model.',
    }),
  ].join(' ')
}

function modelRefusal(args: {
  agentType: AgentType
  isUsable: ModelIsUsable
  reachable: readonly string[]
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
        ? unusableSubagentModelDetail({ modelId, reachable: args.reachable })
        : unusableModelDetail({ modelId, reachable: args.reachable }),
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
  reachableModelIds?: readonly string[] | undefined
  modelIsUsable?: ModelIsUsable | undefined
  subagentModelId?: string | undefined
}): Promise<AgentTypeCatalog> {
  const isUsable = args.modelIsUsable ?? anyModelWhenNoneWereNamed(args.reachableModelIds)
  const reachable = (args.reachableModelIds ?? []).filter(isUsable)
  const read = await Promise.all(args.sources.map((source) => source.load()))

  const refusals: AgentTypeRefusal[] = read.flatMap((entry) => [...entry.refusals])
  const usable: AgentType[] = []

  for (const agentType of read.flatMap((entry) => entry.types)) {
    const refused = modelRefusal({
      agentType,
      isUsable,
      reachable,
      subagentModelId: args.subagentModelId,
    })
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
