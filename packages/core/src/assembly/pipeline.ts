import { cacheBreakpoints } from './annotators/cache-breakpoints'
import type { Annotator, Rule } from './rule'
import { compactedHistory } from './rules/compacted-history'
import { messagesFromEvents } from './rules/messages-from-events'
import { sessionDirectoryBlock } from './rules/session-directory-block'
import { systemPrompt, type PromptSource } from './rules/system-prompt'

export type AssemblyPipeline = {
  rules: readonly Rule[]
  annotators: readonly Annotator[]
}

export function defaultRules({
  prompt,
  projectDirectory,
}: {
  prompt: PromptSource
  projectDirectory: string
}): readonly Rule[] {
  return [
    systemPrompt({ prompt }),
    messagesFromEvents(),
    compactedHistory(),
    sessionDirectoryBlock({ projectDirectory }),
  ]
}

export function defaultAnnotators(): readonly Annotator[] {
  return [cacheBreakpoints()]
}

export function defaultPipeline({
  prompt,
  projectDirectory,
}: {
  prompt: PromptSource
  projectDirectory: string
}): AssemblyPipeline {
  return { rules: defaultRules({ prompt, projectDirectory }), annotators: defaultAnnotators() }
}
