import {
  autoCompactAfterTurn,
  EAutoCompact,
  ECompactionAnchor,
  type ThreadId,
} from '@dltech/atlas-core'
import { useCallback, useRef, useState } from 'react'

import type { Compacting } from '../ui/components/compacting'
import {
  compactTurn,
  ECompaction,
  ECompactScope,
  summariseAt,
  type Compaction,
} from './compact-turn'
import type { AtlasApp } from './compose'

const COMPACTION_CRASHED = 'compacting the history did not finish, so nothing was changed'

export type CompactionControl = {
  compacting: Compacting | null
  compact: (scope: ECompactScope) => void
  compactAround: (args: { anchor: ECompactionAnchor; seq: number }) => void
  compactIfFull: (used: number) => Promise<void>
  cancel: () => boolean
}

export function useCompaction(args: {
  app: AtlasApp
  threadId: ThreadId
  atPercent: number
  readClock: () => number
  refresh: () => Promise<void>
  onFailure: (reason: string) => void
  onCompacted: () => void
}): CompactionControl {
  const { app, threadId, atPercent, readClock, refresh, onFailure, onCompacted } = args
  const [compacting, setCompacting] = useState<Compacting | null>(null)
  const compacter = useRef<AbortController | null>(null)

  const settle = useCallback(
    async (compaction: Compaction) => {
      if (compaction.type === ECompaction.Refused) {
        onFailure(compaction.reason)
        return
      }
      if (compaction.type === ECompaction.Nothing) return

      onCompacted()
      await refresh()
    },
    [onCompacted, onFailure, refresh],
  )

  const run = useCallback(
    async (start: (signal: AbortSignal) => Promise<Compaction>): Promise<void> => {
      if (compacter.current !== null) return

      const controller = new AbortController()
      compacter.current = controller
      setCompacting({ startedAt: readClock(), cancelling: false })

      try {
        const outcome = await start(controller.signal)
        if (!controller.signal.aborted) await settle(outcome)
      } catch {
        if (!controller.signal.aborted) onFailure(COMPACTION_CRASHED)
      } finally {
        compacter.current = null
        setCompacting(null)
      }
    },
    [onFailure, readClock, settle],
  )

  const compact = useCallback(
    (scope: ECompactScope) =>
      void run((signal) =>
        compactTurn({
          log: app.log,
          threads: app.threads,
          threadId,
          scope,
          summarise: app.summarise,
          signal,
        }),
      ),
    [app.log, app.summarise, app.threads, run, threadId],
  )

  const compactAround = useCallback(
    (around: { anchor: ECompactionAnchor; seq: number }) =>
      void run((signal) =>
        summariseAt({
          log: app.log,
          threads: app.threads,
          threadId,
          anchor: around.anchor,
          seq: around.seq,
          summarise: app.summarise,
          signal,
        }),
      ),
    [app.log, app.summarise, app.threads, run, threadId],
  )

  const compactIfFull = useCallback(
    async (used: number) => {
      const window = app.models.cardFor(app.model.choice().ref)?.contextWindow ?? 0
      const decision = autoCompactAfterTurn({ used, window, atPercent })
      if (decision === EAutoCompact.Hold) return

      await run((signal) =>
        compactTurn({
          log: app.log,
          threads: app.threads,
          threadId,
          summarise: app.summarise,
          signal,
        }),
      )
    },
    [app.log, app.model, app.models, app.summarise, app.threads, atPercent, run, threadId],
  )

  /**
   * Interrupting a compaction is not interrupting a turn, and the operator pressed one key for
   * both — so this answers whether it took the press.
   */
  const cancel = useCallback((): boolean => {
    const running = compacter.current
    if (running === null) return false

    setCompacting((current) => (current === null ? null : { ...current, cancelling: true }))
    running.abort()
    return true
  }, [])

  return { compacting, compact, compactAround, compactIfFull, cancel }
}
