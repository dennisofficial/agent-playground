import { useCallback, useEffect, useRef, useState } from 'react'

import type { DiffStat } from '../header-bar'
import { ETerminalFocus } from '../focus-store'
import { probeDiffStat, type DiffStatProbe } from './diff-stat-probe'

export type { DiffStatProbe } from './diff-stat-probe'
export { probeDiffStat } from './diff-stat-probe'

const sameStat = (left: DiffStat | null, right: DiffStat | null): boolean => {
  if (left === null || right === null) return left === right
  return left.added === right.added && left.removed === right.removed
}

/**
 * Probing follows the usePullRequest cadence: once on mount, again when the directory moves, again
 * when a turn ends, and again when the terminal regains focus, since those are what plausibly
 * rewrote the tree — the turn through the agent's own edits, the focus return through edits made
 * elsewhere while the tile sat idle. Every probe is disowned by its effect's cleanup so two runs
 * started against different directories cannot land out of order and re-pin the bar to a place the
 * session has left.
 */
export function useDiffStat(args: {
  projectDirectory: string
  working: boolean
  focus: ETerminalFocus
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

  const tileWasBlurred = useRef(false)
  useEffect(() => {
    const regained = tileWasBlurred.current && args.focus === ETerminalFocus.Focused
    tileWasBlurred.current = args.focus === ETerminalFocus.Blurred
    if (!regained) return

    let owned = true
    void probe(() => owned)

    return () => {
      owned = false
    }
  }, [probe, args.focus])

  return stat
}
