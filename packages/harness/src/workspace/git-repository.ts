import { copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runGit, runGitOrThrow } from './git-command'

export type GitRepository = { toplevel: string; gitDir: string }

export async function discoverRepository(args: { root: string }): Promise<GitRepository> {
  const outcome = await runGit({
    cwd: args.root,
    args: ['rev-parse', '--show-toplevel', '--absolute-git-dir'],
  })
  if (outcome.exitCode !== 0) {
    throw new Error(`${args.root} is not inside a git worktree: ${outcome.stderr.trim()}`)
  }

  const [toplevel, gitDir] = outcome.stdout.trim().split('\n')
  if (toplevel === undefined || gitDir === undefined || toplevel === '') {
    throw new Error(`git rev-parse reported no worktree for ${args.root}`)
  }

  return { toplevel, gitDir }
}

/**
 * The index carries cached stat information for every tracked path, which is what lets `git add`
 * re-hash only the files whose stat data changed. Copying the developer's index into a private one
 * inherits that cache without ever writing to theirs.
 * https://git-scm.com/docs/index-format
 */
export async function createPrivateIndex(args: {
  repository: GitRepository
  seedFromDeveloperIndex: boolean
}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-snapshot-index-'))
  const indexFile = join(directory, 'index')
  if (!args.seedFromDeveloperIndex) return indexFile

  const developerIndex = join(args.repository.gitDir, 'index')
  if (await Bun.file(developerIndex).exists()) await copyFile(developerIndex, indexFile)

  return indexFile
}

/**
 * `git add --all` with no pathspec stages the whole worktree, honouring ignore rules, and
 * `git write-tree` turns the staged state into a tree object whose hash names it. Both act only on
 * GIT_INDEX_FILE, so neither reads nor writes HEAD, the worktree, or the developer's index.
 * https://git-scm.com/docs/git-write-tree
 */
export async function writeWorkingTree(args: {
  repository: GitRepository
  indexFile: string
}): Promise<string> {
  const shared = { cwd: args.repository.toplevel, indexFile: args.indexFile }
  await runGitOrThrow({ ...shared, args: ['add', '--all'] })
  return (await runGitOrThrow({ ...shared, args: ['write-tree'] })).trim()
}
