export type WorkspaceIdentity = {
  workspace: string
  repo: string | null
}

const FILESYSTEM_ROOT = '/'

const normalise = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.length === 0 ? FILESYSTEM_ROOT : trimmed
}

const presentPath = (path: string | undefined): string | null =>
  path === undefined || path.length === 0 ? null : normalise(path)

const parentOf = (path: string): string | null => {
  const separator = path.lastIndexOf('/')
  if (separator < 0) return null
  return separator === 0 ? FILESYSTEM_ROOT : path.slice(0, separator)
}

const repoFrom = (commonDir: string | undefined): string | null => {
  const present = presentPath(commonDir)
  if (present === null || !present.startsWith(FILESYSTEM_ROOT)) return null

  return parentOf(present)
}

export function launchWorktreeOf(identity: WorkspaceIdentity): string | null {
  if (identity.repo === null || identity.repo === identity.workspace) return null
  return identity.workspace
}

export function workspaceFrom(args: {
  cwd: string
  toplevel?: string | undefined
  commonDir?: string | undefined
}): WorkspaceIdentity {
  const toplevel = presentPath(args.toplevel)
  if (toplevel === null) return { workspace: normalise(args.cwd), repo: null }

  return { workspace: toplevel, repo: repoFrom(args.commonDir) }
}
