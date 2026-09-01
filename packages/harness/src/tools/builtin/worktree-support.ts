import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { listWorktrees, type Worktree } from '../../workspace/worktrees'

export const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/

export const MAX_WORKTREE_NAME_LENGTH = 64

export type RepositoryView = { root: string; worktrees: readonly Worktree[] }

export type RepositoryLookup =
  | { ok: true; view: RepositoryView }
  | { ok: false; reason: string }

export async function repositoryAt({ cwd }: { cwd: string }): Promise<RepositoryLookup> {
  const listing = await listWorktrees({ cwd })
  if (!listing.ok) {
    return { ok: false, reason: `${cwd} is not inside a git repository, so there is nothing to branch from` }
  }

  const main = listing.worktrees.find((worktree) => worktree.isMain)
  if (main === undefined) {
    return { ok: false, reason: `git listed no main worktree for the repository at ${cwd}` }
  }

  return { ok: true, view: { root: main.path, worktrees: listing.worktrees } }
}

export const worktreeAt = (args: {
  view: RepositoryView
  path: string
}): Worktree | undefined => args.view.worktrees.find((worktree) => worktree.path === args.path)

export function worktreeHomeOf(args: { repositoryRoot: string; directory: string }): string {
  const { directory } = args
  return isAbsolute(directory) ? directory : resolve(args.repositoryRoot, directory)
}

export function pathForName(args: { home: string; name: string }): string {
  return join(args.home, args.name)
}

export function nameComplaint(name: string): string | undefined {
  if (name.length > MAX_WORKTREE_NAME_LENGTH) {
    return `a worktree name is at most ${MAX_WORKTREE_NAME_LENGTH} characters, and "${name}" is ${name.length}`
  }
  if (!WORKTREE_NAME_PATTERN.test(name)) {
    return `"${name}" is not a usable worktree name: each slash-separated segment may hold only letters, digits, dots, underscores and dashes, and must begin with a letter or digit`
  }
  return undefined
}

/**
 * A `.gitignore` holding `*` inside the worktree home makes the checkouts invisible to git whatever
 * the repository's own ignore rules say, which keeps them out of `git status` without editing a
 * file the developer owns.
 */
export async function hideWorktreeHome({ home }: { home: string }): Promise<void> {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, '.gitignore'), '*\n')
}

export const parentOf = (path: string): string => dirname(path)
