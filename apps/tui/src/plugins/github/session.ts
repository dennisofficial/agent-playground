import {
  enteredWorktreeOf,
  exitedWorktreeOf,
  type AfterTool,
  type AfterTurn,
  type BeforeTurn,
  type OnThreadOpen,
} from '@dltech/atlas-core'

export type SessionFacts = {
  directory: () => string
  working: () => boolean
  version: () => number
  subscribe: (listener: () => void) => () => void
  beforeTurn: BeforeTurn
  afterTurn: AfterTurn
  followWorktree: AfterTool
  threadOpened: OnThreadOpen
}

/**
 * A surface hook takes no arguments, so the two facts the pull request follows — which directory
 * the session is working in, and whether a turn is running — are heard on the hook phases that
 * already carry them rather than passed down from the render tree. The turn boundary brackets
 * `working`, and the directory moves on three edges: `OnThreadOpen` when a conversation becomes
 * visible, the tool result of `enter_worktree` / `exit_worktree` mid-turn, and `BeforeTurn` for
 * anything those two missed.
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
    followWorktree: async ({ result }) => {
      if (!result.ok) return {}

      const entered = enteredWorktreeOf(result.output)
      if (entered !== undefined) {
        if (directory === entered.path) return {}

        directory = entered.path
        announce()
        return {}
      }

      const exited = exitedWorktreeOf(result.output)
      if (exited === undefined) return {}

      const home = exited.returnTo ?? launchDirectory
      if (directory === home) return {}

      directory = home
      announce()
      return {}
    },
    threadOpened: async ({ projectDirectory }) => {
      if (directory === projectDirectory) return {}

      directory = projectDirectory
      announce()
      return {}
    },
  }
}
