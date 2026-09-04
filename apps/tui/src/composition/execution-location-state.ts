import { EExecutionLocation, type ThreadId } from '@dltech/atlas-core'

export type ExecutionLocationState = {
  current: () => EExecutionLocation
  set: (location: EExecutionLocation) => void
  note: (args: { threadId: ThreadId; location: EExecutionLocation }) => void
  of: (threadId: ThreadId) => EExecutionLocation | undefined
  subscribe: (listener: () => void) => () => void
}

export function createExecutionLocationState(args: {
  initial: EExecutionLocation
}): ExecutionLocationState {
  let held = args.initial
  const noted = new Map<ThreadId, EExecutionLocation>()
  const listeners = new Set<() => void>()

  return {
    current: () => held,
    set: (location) => {
      if (held === location) return
      held = location
      for (const listener of listeners) listener()
    },
    note: ({ threadId, location }) => {
      noted.set(threadId, location)
    },
    of: (threadId) => noted.get(threadId),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
