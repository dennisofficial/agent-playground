import type { AgentRegistryPort } from '../../agents/registry/port'
import type { AgentType } from '../../agents/types/agent-type'
import type { InjectionToken } from '../../container/injection'

export type AgentRegistrySource = () => AgentRegistryPort

export const AgentRegistrySourceToken: InjectionToken<AgentRegistrySource> = Symbol(
  'atlas.AgentRegistrySource',
)

export const AgentTypesToken: InjectionToken<readonly AgentType[]> = Symbol('atlas.AgentTypes')
