import {
  EPromptAgent,
  promptContextFor,
  type CompiledPrompt,
  type ProviderIdentity,
  type PromptPart,
} from '@dltech/atlas-core'

import type { PromptRegistry } from '../../prompt/registry'
import type { AgentType } from '../types'

export const AGENT_TYPE_PROMPT_PART = 'agent.type'

export function subAgentPrompt({
  prompts,
  agentType,
  provider,
  projectDirectory,
}: {
  prompts: PromptRegistry
  agentType: AgentType
  provider: ProviderIdentity
  projectDirectory: string
}): CompiledPrompt {
  const compiled = prompts.compile(
    promptContextFor({ agent: EPromptAgent.Sub, provider, projectDirectory }),
  )
  const identity = agentType.prompt.trim()

  const parts: readonly PromptPart[] = [
    ...(identity === ''
      ? []
      : [{ id: AGENT_TYPE_PROMPT_PART, text: identity, chars: identity.length }]),
    ...compiled.parts,
  ]

  if (parts.length === 0) return { blocks: [], parts, skipped: compiled.skipped }

  return {
    blocks: [{ text: parts.map((part) => part.text).join('\n\n') }],
    parts,
    skipped: compiled.skipped,
  }
}
