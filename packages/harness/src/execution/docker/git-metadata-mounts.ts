import { isAbsolute } from 'node:path'

import { isUnderPath } from '@dltech/atlas-core'

import { EMountMode, type Mount } from '../image/mounts'

const gitDirectories = (worktree: string): readonly string[] => {
  try {
    const probe = Bun.spawnSync(
      ['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { cwd: worktree, stdin: 'ignore', stderr: 'ignore' },
    )
    if (!probe.success) return []
    return [...new Set(probe.stdout.toString().trim().split('\n').filter(isAbsolute))]
  } catch {
    return []
  }
}

export function mountsWithGitMetadata(args: {
  worktree: string
  declared: readonly Mount[]
}): readonly Mount[] {
  const directories = gitDirectories(args.worktree).filter(
    (path) => !isUnderPath({ directory: args.worktree, path }),
  )
  const metadata = directories.filter(
    (path) => !directories.some((directory) =>
      directory !== path && isUnderPath({ directory, path }),
    ),
  )
  const mounts = [...args.declared]
  for (const path of metadata) {
    if (mounts.some((mount) => mount.mode === EMountMode.ReadWrite &&
      isUnderPath({ directory: mount.path, path }))) continue
    if (mounts.some((mount) => mount.path === path)) {
      throw new Error(`Git metadata at ${path} needs a read-write mount; the declared mount is read-only`)
    }
    mounts.push({ path, mode: EMountMode.ReadWrite })
  }
  return mounts
}
