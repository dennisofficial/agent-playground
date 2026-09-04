import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { useCallback, useEffect, useRef, useState } from 'react'

import { runGit } from '@dltech/atlas-harness'

import { parseShortStat, type DiffStat } from '../header-bar'

export type DiffStatProbe = (args: { directory: string }) => Promise<DiffStat | null>

const UNTRACKED_SIZE_CAP = 1024 * 1024

const countLines = (content: string): number => {
  if (content.length === 0) return 0
  const breaks = content.split('\n').length - 1
  return content.endsWith('\n') ? breaks : breaks + 1
}

const untrackedLines = async ({ directory }: { directory: string }): Promise<number> => {
  const listed = await runGit({
    args: ['ls-files', '--others', '--exclude-standard', '-z'],
    cwd: directory,
  })
  if (!listed.ok) return 0

  const paths = listed.stdout.split('\0').filter((path) => path.length > 0)
  const counts = await Promise.all(
    paths.map(async (path): Promise<number> => {
      try {
        const entry = await stat(join(directory, path))
        if (!entry.isFile() || entry.size > UNTRACKED_SIZE_CAP) return 0
        return countLines(await Bun.file(join(directory, path)).text())
      } catch {
        return 0
      }
    }),
  )
  return counts.reduce((total, count) => total + count, 0)
}

export const probeDiffStat: DiffStatProbe = async ({ directory }) => {
  const tracked = await runGit({ args: ['diff', '--shortstat', 'HEAD'], cwd: directory })
  const stat = tracked.ok ? parseShortStat(tracked.stdout) : null
  const untracked = await untrackedLines({ directory })

  if (stat === null) return untracked > 0 ? { added: untracked, removed: 0 } : null
  return { added: stat.added + untracked, removed: stat.removed }
}

const sameStat = (left: DiffStat | null, right: DiffStat | null): boolean => {
  if (left === null || right === null) return left === right
  return left.added === right.added && left.removed === right.removed
}

/**
 * Probing follows the usePullRequest cadence: once on mount, again when the directory moves, and
 * again when a turn ends, since the turn is what plausibly rewrote the tree. Every probe is
 * disowned by its effect's cleanup so two runs started against different directories cannot land
 * out of order and re-pin the bar to a place the session has left.
 */
export function useDiffStat(args: {
  projectDirectory: string
  working: boolean
  probe?: DiffStatProbe
}): DiffStat | null {
  const askGit = args.probe ?? probeDiffStat
  const [stat, setStat] = useState<DiffStat | null>(null)

  const probe = useCallback(
    async (owned: () => boolean): Promise<void> => {
      const probed = await askGit({ directory: args.projectDirectory })
      if (!owned()) return

      setStat((current) => (sameStat(current, probed) ? current : probed))
    },
    [askGit, args.projectDirectory],
  )

  useEffect(() => {
    let owned = true
    void probe(() => owned)

    return () => {
      owned = false
    }
  }, [probe])

  const turnWasRunning = useRef(false)
  useEffect(() => {
    const ended = turnWasRunning.current && !args.working
    turnWasRunning.current = args.working
    if (!ended) return

    let owned = true
    void probe(() => owned)

    return () => {
      owned = false
    }
  }, [probe, args.working])

  return stat
}
