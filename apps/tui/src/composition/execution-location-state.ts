import { EExecutionLocation, type ThreadId } from '@dltech/atlas-core'

export type ExecutionLocationState = {
  current: () => EExecutionLocation
  set: (location: EExecutionLocation) => void
  note: (args: { threadId: ThreadId; location: EExecutionLocation }) => void
  of: (threadId: ThreadId) => EExecutionLocation | undefined
  subscribe: (listener: () => void) => () => void
}

/**
 * Two readings of the same truth: the cell is where the conversation on screen runs, and the
 * per-thread record is what the process router asks, since a spawn names its thread rather than
 * the one being viewed. Only threads the operator has opened this session are noted; the router's
 * fallback for any other is the cell itself.
 */
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
