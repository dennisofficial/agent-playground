import { resolveShadowing } from '@dltech/atlas-core'

import { AGENT_SPAWN_TOOL_NAME, type AgentType, type AgentTypeSource } from './agent-type'

const withoutSelfSpawn = (agentType: AgentType): AgentType => ({
  ...agentType,
  tools: agentType.tools?.filter((tool) => tool !== AGENT_SPAWN_TOOL_NAME),
  disallowedTools: [...new Set([...(agentType.disallowedTools ?? []), AGENT_SPAWN_TOOL_NAME])],
})

export async function loadAgentTypes(args: {
  sources: readonly AgentTypeSource[]
}): Promise<readonly AgentType[]> {
  const loaded = await Promise.all(args.sources.map((source) => source.load()))

  const resolved = resolveShadowing({
    definitions: loaded.flat(),
    nameOf: (agentType) => agentType.name,
  })

  return resolved.map(withoutSelfSpawn)
}
