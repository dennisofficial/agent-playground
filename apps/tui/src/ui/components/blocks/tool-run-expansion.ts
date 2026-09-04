import type { ToolRun } from '../../../store'

export const moreKey = (callId: string): string => `more:${callId}`

export const sentenceKey = (callId: string): string => `sentence:${callId}`

const expansionKeysOf = (run: ToolRun): readonly string[] =>
  run.calls.flatMap((call) => [call.callId, moreKey(call.callId), sentenceKey(call.callId)])

export type OpenedSubsets = WeakMap<ToolRun, ReadonlySet<string>>

export const openedSubsetOf = (args: {
  cache: OpenedSubsets
  run: ToolRun
  opened: ReadonlySet<string>
}): ReadonlySet<string> => {
  const next = new Set(expansionKeysOf(args.run).filter((key) => args.opened.has(key)))
  const held = args.cache.get(args.run)
  if (held !== undefined && held.size === next.size && [...next].every((key) => held.has(key))) {
    return held
  }

  args.cache.set(args.run, next)
  return next
}
