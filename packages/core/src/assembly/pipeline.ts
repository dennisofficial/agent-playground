import { cacheBreakpoints } from './annotators/cache-breakpoints'
import type { Annotator, Rule } from './rule'
import { agentEndingsBlock } from './rules/agent-endings-block'
import { compactedHistory } from './rules/compacted-history'
import {
  executionLocationBlock,
  type ExecutionLocationSource,
} from './rules/execution-location-block'
import { imagesInContext } from './rules/images'
import { messagesFromEvents } from './rules/messages-from-events'
import { runningAgentsBlock, type RunningAgentsSource } from './rules/running-agents-block'
import { runningServicesBlock, type RunningServicesSource } from './rules/running-services-block'
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
  repoRoot,
  runningShells,
  runningServices,
  runningAgents,
  executionLocation,
}: {
  prompt: PromptSource
  launchDirectory: string
  repoRoot?: string | undefined
  runningShells?: RunningShellsSource | undefined
  runningServices?: RunningServicesSource | undefined
  runningAgents?: RunningAgentsSource | undefined
  executionLocation?: ExecutionLocationSource | undefined
}): readonly Rule[] {
  return [
    systemPrompt({ prompt, launchDirectory }),
    messagesFromEvents(),
    agentEndingsBlock(),
    compactedHistory(),
    imagesInContext(),
    worktreeBlock({ launchDirectory, repoRoot }),
    ...(executionLocation === undefined ? [] : [executionLocationBlock({ executionLocation })]),
    ...(runningShells === undefined ? [] : [runningShellsBlock({ runningShells })]),
    ...(runningServices === undefined ? [] : [runningServicesBlock({ runningServices })]),
    ...(runningAgents === undefined ? [] : [runningAgentsBlock({ runningAgents })]),
  ]
}

export function defaultAnnotators(): readonly Annotator[] {
  return [cacheBreakpoints()]
}

export function defaultPipeline({
  prompt,
  launchDirectory,
  repoRoot,
  runningShells,
  runningServices,
  runningAgents,
  executionLocation,
}: {
  prompt: PromptSource
  launchDirectory: string
  repoRoot?: string | undefined
  runningShells?: RunningShellsSource | undefined
  runningServices?: RunningServicesSource | undefined
  runningAgents?: RunningAgentsSource | undefined
  executionLocation?: ExecutionLocationSource | undefined
}): AssemblyPipeline {
  return {
    rules: defaultRules({
      prompt,
      launchDirectory,
      repoRoot,
      runningShells,
      runningServices,
      runningAgents,
      executionLocation,
    }),
    annotators: defaultAnnotators(),
  }
}
