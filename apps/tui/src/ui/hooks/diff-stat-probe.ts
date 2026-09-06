import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { runGit, type GitRun } from '@dltech/atlas-harness'

import { parseShortStat, type DiffStat } from '../header-bar'

export type DiffStatProbe = (args: { directory: string }) => Promise<DiffStat | null>

export type GitRunner = (args: {
  args: readonly string[]
  cwd: string
}) => Promise<GitRun>

// git's well-known empty tree, the only tree hash that exists in every repository — the diff
// base for a repository whose HEAD does not resolve yet.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const UNTRACKED_SIZE_CAP = 1024 * 1024

const countLines = (content: string): number => {
  if (content.length === 0) return 0
  const breaks = content.split('\n').length - 1
  return content.endsWith('\n') ? breaks : breaks + 1
}

const shortStatAgainstHead = async (args: {
  run: GitRunner
  directory: string
}): Promise<DiffStat | null> => {
  const againstHead = await args.run({ args: ['diff', '--shortstat', 'HEAD'], cwd: args.directory })
  const result = againstHead.ok
    ? againstHead
    : await args.run({ args: ['diff', '--shortstat', EMPTY_TREE], cwd: args.directory })
  return result.ok ? parseShortStat(result.stdout) : null
}

type LineCount = { mtimeMs: number; size: number; lines: number }

export function createDiffStatProbe(deps?: {
  run?: GitRunner
  readText?: (path: string) => Promise<string>
}): DiffStatProbe {
  const run = deps?.run ?? runGit
  const readText = deps?.readText ?? ((path: string) => Bun.file(path).text())
  const remembered = new Map<string, LineCount>()

  const untrackedLines = async ({ directory }: { directory: string }): Promise<number> => {
    const listed = await run({
      args: ['ls-files', '--others', '--exclude-standard', '-z'],
      cwd: directory,
    })
    if (!listed.ok) return 0

    const paths = listed.stdout.split('\0').filter((path) => path.length > 0)
    const seen = new Set<string>()
    const counts = await Promise.all(
      paths.map(async (path): Promise<number> => {
        const key = `${directory}\0${path}`
        seen.add(key)
        try {
          const entry = await stat(join(directory, path))
          if (!entry.isFile() || entry.size > UNTRACKED_SIZE_CAP) {
            remembered.delete(key)
            return 0
          }
          const hit = remembered.get(key)
          if (hit && hit.mtimeMs === entry.mtimeMs && hit.size === entry.size) return hit.lines

          const lines = countLines(await readText(join(directory, path)))
          remembered.set(key, { mtimeMs: entry.mtimeMs, size: entry.size, lines })
          return lines
        } catch {
          remembered.delete(key)
          return 0
        }
      }),
    )
    for (const key of remembered.keys()) {
      if (!seen.has(key)) remembered.delete(key)
    }
    return counts.reduce((total, count) => total + count, 0)
  }

  return async ({ directory }) => {
    const stat = await shortStatAgainstHead({ run, directory })
    const untracked = await untrackedLines({ directory })

    if (stat === null) return untracked > 0 ? { added: untracked, removed: 0 } : null
    return { added: stat.added + untracked, removed: stat.removed }
  }
}

export const probeDiffStat: DiffStatProbe = createDiffStatProbe()
