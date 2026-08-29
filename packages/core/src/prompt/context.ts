import type { ModelEntry } from '../models/catalog'
import { modelEntry } from '../models/registry'
import type { ProviderIdentity } from '../provider'
import type { EPromptAgent } from './agent'

export type PromptContext = {
  agent: EPromptAgent
  provider: ProviderIdentity
  model: ModelEntry | undefined
}

export function promptContextFor({
  agent,
  provider,
}: {
  agent: EPromptAgent
  provider: ProviderIdentity
}): PromptContext {
  return { agent, provider, model: modelEntry(provider.modelId) }
}

export function promptContextKey({ agent, provider }: PromptContext): string {
  return JSON.stringify([agent, provider.id, provider.modelId])
}
