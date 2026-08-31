import type { ModelPort } from '@dltech/atlas-core'

import type { AgentType } from './agent-type'

export type PinnedModelBuild = (args: { modelId: string }) => ModelPort

export type AgentModelSource = (args: { agentType: AgentType }) => ModelPort

export function pinnedModelSource(args: {
  inherited: () => ModelPort
  build: PinnedModelBuild
}): AgentModelSource {
  return ({ agentType }) => {
    const modelId = agentType.model
    return modelId === undefined ? args.inherited() : args.build({ modelId })
  }
}
