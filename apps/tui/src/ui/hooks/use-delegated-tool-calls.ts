import { useCallback, useSyncExternalStore } from 'react'

import type { ThreadId } from '@dltech/atlas-core'
import type { AgentSnapshot } from '@dltech/atlas-harness'

export type DelegatedProgress = {
  list(args: { threadId: ThreadId }): readonly AgentSnapshot[]
  onChange(listener: () => void): () => void
}

const toolCallsOf = (children: readonly AgentSnapshot[]): number =>
  children.reduce((total, snapshot) => total + snapshot.toolCalls, 0)

export function useDelegatedToolCalls(args: {
  agents: DelegatedProgress
  threadId: ThreadId
}): number {
  const { agents, threadId } = args
  const subscribe = useCallback(
    (listener: () => void) => agents.onChange(listener),
    [agents],
  )
  const read = useCallback(() => toolCallsOf(agents.list({ threadId })), [agents, threadId])

  return useSyncExternalStore(subscribe, read)
}
