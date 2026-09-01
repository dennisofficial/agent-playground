import { runGit } from '@dltech/atlas-harness'

import { checkoutOf, type NamedRemote, type RepositoryCheckout } from './pure'

const DETACHED_HEAD = 'HEAD'

const REMOTE_PREFIX = 'remote.'

const URL_SUFFIX = '.url'

const remotesOf = (output: string): readonly NamedRemote[] =>
  output
    .split('\n')
    .map((line) => line.trim())
    .flatMap((line): NamedRemote[] => {
      const space = line.indexOf(' ')
      if (space === -1) return []

      const key = line.slice(0, space)
      if (!key.startsWith(REMOTE_PREFIX) || !key.endsWith(URL_SUFFIX)) return []

      const name = key.slice(REMOTE_PREFIX.length, -URL_SUFFIX.length)
      const url = line.slice(space + 1).trim()
      if (name.length === 0 || url.length === 0) return []

      return [{ name, url }]
    })

/**
 * The branch is always asked of git rather than read off `worktree-entered`, which records what the
 * branch was at entry: the model can `git checkout -b` inside a worktree mid-turn, and a log-derived
 * branch would key the cache to a branch nobody is on.
 */
export async function probeCheckout({
  directory,
}: {
  directory: string
}): Promise<RepositoryCheckout | null> {
  const head = await runGit({ args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: directory })
  if (!head.ok) return null

  const branch = head.stdout.trim()
  if (branch.length === 0 || branch === DETACHED_HEAD) return null

  const config = await runGit({
    args: ['config', '--get-regexp', '^remote\\..*\\.url'],
    cwd: directory,
  })
  if (!config.ok) return null

  return checkoutOf({ directory, branch, remotes: remotesOf(config.stdout) })
}
