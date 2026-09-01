import type { ProviderIdentity } from '../provider'
import type { EPromptAgent } from './agent'
import type { PromptModel } from './model'

export type PromptContext = {
  agent: EPromptAgent
  provider: ProviderIdentity
  model: PromptModel
  projectDirectory: string
}

export function promptContextFor({
  agent,
  provider,
  model,
  projectDirectory,
}: {
  agent: EPromptAgent
  provider: ProviderIdentity
  model: PromptModel
  projectDirectory: string
}): PromptContext {
  return { agent, provider, model, projectDirectory }
}

export function promptContextKey({ agent, provider, projectDirectory }: PromptContext): string {
  return JSON.stringify([agent, provider.id, provider.modelId, projectDirectory])
}
