import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { runGitOrThrow } from './git-command'
import type { GitRepository } from './git-repository'

enum EWorktreeChange {
  Overwrite = 'overwrite',
  Delete = 'delete',
}

type WorktreeChange = { change: EWorktreeChange; path: string }

const ADDED_SINCE_TARGET = 'A'

function changesBetweenTrees(output: string): readonly WorktreeChange[] {
  const fields = output.split('\0').filter((field) => field !== '')
  const changes: WorktreeChange[] = []

  for (let at = 0; at + 1 < fields.length; at += 2) {
    const status = fields.at(at)
    const path = fields.at(at + 1)
    if (status === undefined || path === undefined) continue
    changes.push({
      change: status === ADDED_SINCE_TARGET ? EWorktreeChange.Delete : EWorktreeChange.Overwrite,
      path,
    })
  }

  return changes
}

/**
 * `git diff-tree --name-status` reports each path's status in the second tree relative to the first,
 * so a path added since the target reads as `A` and has to be removed rather than written.
 * `git checkout-index --stdin` then writes the target's own blobs from the private index.
 * https://git-scm.com/docs/git-diff-tree
 * https://git-scm.com/docs/git-checkout-index
 */
export async function applyTree(args: {
  repository: GitRepository
  indexFile: string
  target: string
  current: string
}): Promise<void> {
  const shared = { cwd: args.repository.toplevel, indexFile: args.indexFile }
  const changes = changesBetweenTrees(
    await runGitOrThrow({
      ...shared,
      args: ['diff-tree', '-r', '-z', '--no-renames', '--name-status', args.target, args.current],
    }),
  )

  await runGitOrThrow({ ...shared, args: ['read-tree', args.target] })

  const overwritten = changes
    .filter((change) => change.change === EWorktreeChange.Overwrite)
    .map((change) => change.path)

  if (overwritten.length > 0) {
    await runGitOrThrow({
      ...shared,
      args: ['checkout-index', '--force', '-z', '--stdin'],
      stdin: overwritten.map((path) => `${path}\0`).join(''),
    })
  }

  for (const change of changes) {
    if (change.change !== EWorktreeChange.Delete) continue
    await rm(join(args.repository.toplevel, change.path), { force: true })
  }
}
