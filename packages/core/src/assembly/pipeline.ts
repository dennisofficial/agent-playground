import { cacheBreakpoints } from './annotators/cache-breakpoints'
import type { Annotator, Rule } from './rule'
import { agentEndingsBlock } from './rules/agent-endings-block'
import { compactedHistory } from './rules/compacted-history'
import { imagesInContext } from './rules/images'
import { messagesFromEvents } from './rules/messages-from-events'
import { runningAgentsBlock, type RunningAgentsSource } from './rules/running-agents-block'
import { runningShellsBlock, type RunningShellsSource } from './rules/running-shells-block'
import { systemPrompt, type PromptSource } from './rules/system-prompt'
import { worktreeBlock } from './rules/worktree-block'

export type AssemblyPipeline = {
  rules: readonly Rule[]
  annotators: readonly Annotator[]
}

export function defaultRules({
  prompt,
  launchDirectory,
  runningShells,
  runningAgents,
}: {
  prompt: PromptSource
  launchDirectory: string
  runningShells?: RunningShellsSource | undefined
  runningAgents?: RunningAgentsSource | undefined
}): readonly Rule[] {
  return [
    systemPrompt({ prompt, launchDirectory }),
    messagesFromEvents(),
    agentEndingsBlock(),
    compactedHistory(),
    imagesInContext(),
    worktreeBlock({ launchDirectory }),
    ...(runningShells === undefined ? [] : [runningShellsBlock({ runningShells })]),
    ...(runningAgents === undefined ? [] : [runningAgentsBlock({ runningAgents })]),
  ]
}

export function defaultAnnotators(): readonly Annotator[] {
  return [cacheBreakpoints()]
}

export function defaultPipeline({
  prompt,
  launchDirectory,
  runningShells,
  runningAgents,
}: {
  prompt: PromptSource
  launchDirectory: string
  runningShells?: RunningShellsSource | undefined
  runningAgents?: RunningAgentsSource | undefined
}): AssemblyPipeline {
  return {
    rules: defaultRules({ prompt, launchDirectory, runningShells, runningAgents }),
    annotators: defaultAnnotators(),
  }
}
