import { toSnapshotId, type WorkspacePort } from '@dltech/atlas-core'

import { applyTree } from './apply-tree'
import { createPrivateIndex, discoverRepository, writeWorkingTree, type GitRepository } from './git-repository'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createGitWorkspace(args: { root: string }): WorkspacePort {
  let repository: Promise<GitRepository> | undefined
  let indexFile: Promise<string> | undefined
  let seedFromDeveloperIndex = true
  let queue: Promise<unknown> = Promise.resolve()

  const repositoryOf = (): Promise<GitRepository> =>
    (repository ??= discoverRepository({ root: args.root }))

  const indexFileOf = (): Promise<string> =>
    (indexFile ??= repositoryOf().then((resolved) =>
      createPrivateIndex({ repository: resolved, seedFromDeveloperIndex }),
    ))

  const treeOfWorkingState = async (): Promise<string> => {
    try {
      return await writeWorkingTree({
        repository: await repositoryOf(),
        indexFile: await indexFileOf(),
      })
    } catch (error) {
      if (!seedFromDeveloperIndex) throw error
      seedFromDeveloperIndex = false
      indexFile = undefined
      return writeWorkingTree({ repository: await repositoryOf(), indexFile: await indexFileOf() })
    }
  }

  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const settled = queue.then(work, work)
    queue = settled.then(
      () => undefined,
      () => undefined,
    )
    return settled
  }

  return {
    root: args.root,

    snapshot: ({ label }) =>
      serialized(async () => {
        try {
          return toSnapshotId(await treeOfWorkingState())
        } catch (error) {
          throw new Error(`could not snapshot the workspace for ${label}: ${messageOf(error)}`)
        }
      }),

    restore: ({ snapshotId }) =>
      serialized(async () => {
        const current = await treeOfWorkingState()
        if (current === snapshotId) return
        await applyTree({
          repository: await repositoryOf(),
          indexFile: await indexFileOf(),
          target: snapshotId,
          current,
        })
      }),
  }
}
