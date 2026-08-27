import { cacheBreakpoints } from './annotators/cache-breakpoints'
import type { Annotator, Rule } from './rule'
import { compactedHistory } from './rules/compacted-history'
import { messagesFromEvents } from './rules/messages-from-events'
import { systemPreamble, type PreambleWorkspace } from './rules/system-preamble'

export type AssemblyPipeline = {
  rules: readonly Rule[]
  annotators: readonly Annotator[]
}

export function defaultRules(workspace?: PreambleWorkspace): readonly Rule[] {
  return [systemPreamble(workspace), messagesFromEvents(), compactedHistory()]
}

export function defaultAnnotators(): readonly Annotator[] {
  return [cacheBreakpoints()]
}

export function defaultPipeline(workspace?: PreambleWorkspace): AssemblyPipeline {
  return { rules: defaultRules(workspace), annotators: defaultAnnotators() }
}
