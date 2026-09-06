import { resolveAgainst, isUnderPath } from './classifier/path-set'
import { homeDotDirectory, insideTemporaryRoot } from './classifier/shapes'

const isPersonalDotPath = ({ path }: { path: string }): boolean => {
  const topLevelUnderHome = homeDotDirectory({ path })
  return topLevelUnderHome !== undefined && topLevelUnderHome.startsWith('.')
}

export function outsideProjectNotice({
  path,
  projectDirectory,
}: {
  path: string
  projectDirectory: string
}): string | undefined {
  const resolved = resolveAgainst({ base: projectDirectory, path })

  if (isUnderPath({ directory: projectDirectory, path: resolved })) return undefined
  if (insideTemporaryRoot({ path: resolved })) return undefined
  if (isPersonalDotPath({ path: resolved })) return undefined

  return `You just wrote to ${resolved}, which is outside this session's project directory (${projectDirectory}). If the work belongs there — another worktree of this repository, say — switch to it with enter_worktree rather than editing across checkouts, so the session, its diffs and its PR stay in one tree. If it was a deliberate one-off outside the project (config, memory, scratch), carry on.`
}
