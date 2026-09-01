import type { AfterTurn, BeforeTurn } from '@dltech/atlas-core'

export type SessionFacts = {
  directory: () => string
  working: () => boolean
  version: () => number
  subscribe: (listener: () => void) => () => void
  beforeTurn: BeforeTurn
  afterTurn: AfterTurn
}

/**
 * A surface hook takes no arguments, so the two facts the pull request follows — which directory
 * the session is working in, and whether a turn is running — are heard on the hook phases that
 * already carry them rather than passed down from the render tree. `BeforeTurn` is the only phase
 * that names a project directory, and the turn boundary it brackets with `AfterTurn` is the same
 * edge a re-probe used to key on.
 */
export function createSessionFacts({ launchDirectory }: { launchDirectory: string }): SessionFacts {
  const listeners = new Set<() => void>()

  let directory = launchDirectory
  let working = false
  let version = 0

  const announce = (): void => {
    version += 1
    for (const listener of listeners) listener()
  }

  return {
    directory: () => directory,
    working: () => working,
    version: () => version,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    beforeTurn: async ({ projectDirectory }) => {
      if (directory === projectDirectory && working) return {}

      directory = projectDirectory
      working = true
      announce()
      return {}
    },
    afterTurn: async () => {
      if (!working) return {}

      working = false
      announce()
      return {}
    },
  }
}
