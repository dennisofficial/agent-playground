import { EDefinitionOrigin } from '@dltech/atlas-core'

import { AgentTypeSource, type AgentType } from './agent-type'
import { BUILT_IN_AGENT_TYPES } from './built-ins'

export class EmbeddedAgentTypeSource extends AgentTypeSource {
  readonly origin = EDefinitionOrigin.BuiltIn

  async load(): Promise<readonly AgentType[]> {
    return BUILT_IN_AGENT_TYPES.map((agentType) => ({ ...agentType, origin: this.origin }))
  }
}
