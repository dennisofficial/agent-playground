import { useCallback, useEffect, useRef, useState } from 'react'

import type { DiffStat } from '../header-bar'
import { ETerminalFocus } from '../focus-store'
import { probeDiffStat, type DiffStatProbe } from './diff-stat-probe'

const sameStat = (left: DiffStat | null, right: DiffStat | null): boolean => {
  if (left === null || right === null) return left === right
  return left.added === right.added && left.removed === right.removed
}

function useProbeOnTransition(args: {
  probe: (owned: () => boolean) => Promise<void>
  from: boolean
  to: boolean
}): void {
  const wasFrom = useRef(false)
  useEffect(() => {
    const fired = wasFrom.current && args.to
    wasFrom.current = args.from
    if (!fired) return

    let owned = true
    void args.probe(() => owned)

    return () => {
      owned = false
    }
  }, [args.probe, args.from, args.to])
}

export function useDiffStat(args: {
  projectDirectory: string
  working: boolean
  focus: ETerminalFocus
  mutations: number
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

  useProbeOnTransition({ probe, from: args.working, to: !args.working })
  useProbeOnTransition({
    probe,
    from: args.focus === ETerminalFocus.Blurred,
    to: args.focus === ETerminalFocus.Focused,
  })

  const countedMutations = useRef(args.mutations)
  useEffect(() => {
    const grew = args.mutations > countedMutations.current
    countedMutations.current = args.mutations
    if (!grew) return

    let owned = true
    void probe(() => owned)

    return () => {
      owned = false
    }
  }, [probe, args.mutations])

  return stat
}
