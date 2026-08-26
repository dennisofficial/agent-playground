import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

export type WorkspaceContainment = {
  root: string
  contains(path: string): Promise<boolean>
  escapeeOf(path: string): Promise<string | undefined>
}

function isWithin({ root, target }: { root: string; target: string }): boolean {
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

async function realpathOfNearestExisting(target: string): Promise<string> {
  const missing: string[] = []
  let current = target

  for (;;) {
    try {
      return join(await realpath(current), ...missing)
    } catch {
      const parent = dirname(current)
      if (parent === current) return target
      missing.unshift(basename(current))
      current = parent
    }
  }
}

export function createWorkspaceContainment(args: { root: string }): WorkspaceContainment {
  const root = resolve(args.root)

  let resolvedRoot: Promise<string> | undefined
  const realRootOnce = (): Promise<string> => (resolvedRoot ??= realpathOfNearestExisting(root))

  const escapeeOf = async (path: string): Promise<string | undefined> => {
    const [realRoot, realTarget] = await Promise.all([
      realRootOnce(),
      realpathOfNearestExisting(resolve(path)),
    ])

    return isWithin({ root: realRoot, target: realTarget }) ? undefined : realTarget
  }

  return {
    root,
    escapeeOf,
    contains: async (path) => (await escapeeOf(path)) === undefined,
  }
}
