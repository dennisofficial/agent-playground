import type { ModelEntry } from '../models/catalog'
import { modelEntry } from '../models/registry'
import type { ProviderIdentity } from '../provider'
import type { EPromptAgent } from './agent'

export type PromptContext = {
  agent: EPromptAgent
  provider: ProviderIdentity
  model: ModelEntry | undefined
  projectDirectory: string
}

export function promptContextFor({
  agent,
  provider,
  projectDirectory,
}: {
  agent: EPromptAgent
  provider: ProviderIdentity
  projectDirectory: string
}): PromptContext {
  return { agent, provider, model: modelEntry(provider.modelId), projectDirectory }
}

export function promptContextKey({ agent, provider, projectDirectory }: PromptContext): string {
  return JSON.stringify([agent, provider.id, provider.modelId, projectDirectory])
}
