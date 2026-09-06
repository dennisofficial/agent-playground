import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

type Candidate = {
  readonly path: string
  readonly hops: number
}

const identityKeyOf = (identity: { dev: number; ino: number }): string => `${identity.dev}:${identity.ino}`

const ranksBetter = (next: Candidate, current: Candidate): boolean => {
  if (next.hops !== current.hops) return next.hops < current.hops
  return next.path < current.path
}

const ascendOutOf = (args: { pattern: string; cwd: string }): { pattern: string; cwd: string } => {
  let cwd = args.cwd
  let pattern = args.pattern
  while (pattern.startsWith('../')) {
    pattern = pattern.slice(3)
    cwd = dirname(cwd)
  }
  return { pattern, cwd }
}

/**
 * Bun.Glob.scan follows no symlinks, and with followSymlinks it recurses forever on a link
 * cycle, so traversal lives here: links are followed, a directory already on the ancestor chain
 * is never re-entered, and a file reachable by two paths is reported once, by the route that
 * crosses fewer links.
 */
export async function walkGlob(args: {
  pattern: string
  cwd: string
  dot: boolean
}): Promise<string[]> {
  const { pattern, cwd } = ascendOutOf({ pattern: args.pattern, cwd: args.cwd })
  const matcher = new Bun.Glob(pattern)
  const bestByInode = new Map<string, Candidate>()

  const root = await stat(cwd).catch(() => null)
  if (root === null) return []

  const consider = (candidate: Candidate, identityKey: string, relative: string): void => {
    if (!matcher.match(relative)) return
    const current = bestByInode.get(identityKey)
    if (current === undefined || ranksBetter(candidate, current)) bestByInode.set(identityKey, candidate)
  }

  const walk = async (
    directory: string,
    relative: string,
    ancestry: ReadonlySet<string>,
    hops: number,
  ): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => null)
    if (entries === null) return

    for (const entry of entries) {
      if (!args.dot && entry.name.startsWith('.')) continue

      const path = join(directory, entry.name)
      const entryRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
      const identity = await stat(path).catch(() => null)
      if (identity === null) continue

      const entryHops = entry.isSymbolicLink() ? hops + 1 : hops

      if (identity.isDirectory()) {
        const key = identityKeyOf(identity)
        if (ancestry.has(key)) continue
        await walk(path, entryRelative, new Set(ancestry).add(key), entryHops)
        continue
      }

      if (identity.isFile()) {
        consider({ path, hops: entryHops }, identityKeyOf(identity), entryRelative)
      }
    }
  }

  await walk(cwd, '', new Set([identityKeyOf(root)]), 0)

  return [...bestByInode.values()].map((candidate) => candidate.path)
}
