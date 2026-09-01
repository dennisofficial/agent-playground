import {
  isResumable,
  resumeDrafts,
  type Event,
  type EventDraft,
  type ModelUsage,
  type ThreadId,
} from '@dltech/atlas-core'
import { ETurnStatus, rewindThread, type TurnOutcome } from '@dltech/atlas-harness'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import type { ConversationStore } from '../store'
import type { AtlasApp } from './compose'
import { discardInterrupted, EDiscard } from './resume-turn'
import { EUndo, undoTurn } from './undo-turn'
import {
  IDLE_PROGRESS,
  stoppageOf,
  turnAdvanced,
  turnInterrupting,
  turnSettled,
  turnStarted,
  type TurnProgress,
} from './turn-progress'

const UNEXPLAINED = 'The turn stopped for a reason it did not name.'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : UNEXPLAINED)

const committedNothing = (outcome: TurnOutcome): boolean =>
  outcome.status === ETurnStatus.Interrupted && !outcome.committed

type CommitGate = { reached: Promise<void>; settle: () => void }

const commitGate = (): CommitGate => {
  let settle = (): void => undefined
  const reached = new Promise<void>((resolve) => {
    settle = () => resolve()
  })

  return { reached, settle }
}

export type TurnDriver = {
  working: boolean
  progress: TurnProgress
  drive: (drafts: readonly EventDraft[]) => Promise<void>
  handleInterrupt: () => void
  handleRetry: () => void
  handleResume: () => void
  handleResumeFresh: () => void
  handleRewindTo: (toSeq: number) => void
  isResumable: boolean
  settle: () => void
}

export function useTurnDriver(args: {
  app: AtlasApp
  threadId: ThreadId
  started: RefObject<boolean>
  store: ConversationStore
  events: readonly Event[]
  refresh: () => Promise<void>
  readClock: () => number
  used: RefObject<number>
  compactIfFull: (used: number) => Promise<void>
  cancelCompaction: () => boolean
  onUndone: (text: string) => void
  onUsage: (usage: ModelUsage) => void
  setFailure: (reason: string | null) => void
  forgetUsage: () => void
}): TurnDriver {
  const { app, threadId, started, store, events, refresh, readClock, used, compactIfFull } = args
  const { cancelCompaction, onUndone, setFailure, forgetUsage } = args

  const [progress, setProgress] = useState<TurnProgress>(IDLE_PROGRESS)
  const [working, setWorking] = useState(false)
  const abort = useRef<AbortController | null>(null)

  /**
   * A conversation nobody has spoken in has an id but no thread behind it, so the first drafts open
   * the thread and land in the same transaction: nothing reaches the store until there is something
   * to say, and a session abandoned at the welcome screen leaves nothing to resume.
   */
  const commit = useCallback(
    async (drafts: readonly EventDraft[]): Promise<void> => {
      const runId = app.ids.nextRunId()

      if (started.current) {
        await app.log.append({ threadId, runId, drafts })
        return
      }

      await app.threads.createWithFirstEvents({
        threadId,
        drafts,
        runId,
        workspace: app.workspace.workspace,
        repo: app.workspace.repo,
      })
      started.current = true
    },
    [app.ids, app.log, app.threads, app.workspace, started, threadId],
  )

  useEffect(
    () =>
      app.channel.subscribe({
        threadId,
        listener: (signal) => {
          setProgress((current) => turnAdvanced({ progress: current, signal, now: readClock() }))
          if (signal.type === 'chunk' && signal.chunk.type === 'finish') {
            const usage = signal.chunk.usage
            if (usage !== undefined) args.onUsage(usage)
          }
          if (signal.type === 'step-ended' || signal.type === 'events-appended') void refresh()
        },
      }),
    [app, threadId, refresh, readClock],
  )

  const undo = useCallback(async () => {
    const undone = await undoTurn({ log: app.log, threads: app.threads, threadId })

    if (undone.type === EUndo.Refused) {
      setFailure(undone.reason)
      return
    }
    if (undone.type === EUndo.Nothing) return

    await refresh()
    onUndone(undone.text)
  }, [app.log, app.threads, onUndone, refresh, setFailure, threadId])

  const drive = useCallback(
    (drafts: readonly EventDraft[]): Promise<void> => {
      const controller = new AbortController()
      const gate = commitGate()

      abort.current = controller
      setWorking(true)
      setFailure(null)
      store.supersedeFailure()
      setProgress(turnStarted({ now: readClock() }))

      void (async () => {
        try {
          if (drafts.length > 0) {
            await commit(drafts)
            await refresh()
          }
          gate.settle()
          const outcome = await app.runner.runTurn({ threadId, signal: controller.signal })
          setFailure(stoppageOf(outcome))
          if (committedNothing(outcome)) await undo()
        } catch (error) {
          setFailure(messageOf(error))
        } finally {
          gate.settle()
          abort.current = null
          setWorking(false)
          setProgress((current) => turnSettled({ progress: current, now: readClock() }))
          await refresh().catch(() => undefined)
          await compactIfFull(used.current).catch(() => undefined)
        }
      })()

      return gate.reached
    },
    [app, commit, compactIfFull, readClock, refresh, setFailure, store, threadId, undo, used],
  )

  /**
   * A failed turn leaves its events durable, so retrying is the same turn run again with nothing
   * appended — the loop picks up from the last event rather than replaying what already landed.
   */
  const handleRetry = useCallback(() => {
    if (working) return
    void drive([])
  }, [drive, working])

  const handleResume = useCallback(() => {
    if (working) return
    void drive(resumeDrafts(events))
  }, [drive, events, working])

  const handleResumeFresh = useCallback(() => {
    if (working) return

    void (async () => {
      const discarded = await discardInterrupted({
        log: app.log,
        threads: app.threads,
        threadId,
      })

      if (discarded.type === EDiscard.Refused) {
        setFailure(discarded.reason)
        return
      }

      forgetUsage()
      await refresh()
      void drive([])
    })()
  }, [app.log, app.threads, drive, forgetUsage, refresh, setFailure, threadId, working])

  const rewindTo = useCallback(
    async (toSeq: number) => {
      const rewound = await rewindThread({ log: app.log, threads: app.threads, threadId, toSeq })

      if (!rewound.ok) {
        setFailure(rewound.reason)
        return
      }
      forgetUsage()
      await refresh()
    },
    [app.log, app.threads, forgetUsage, refresh, setFailure, threadId],
  )

  /**
   * One key stops whatever is running, and a compaction is not a turn — so the compaction is
   * offered the press first and the turn only aborts if it was not taken.
   */
  const handleInterrupt = useCallback(() => {
    if (cancelCompaction()) return

    const controller = abort.current
    if (controller === null) return

    setProgress(turnInterrupting)
    controller.abort()
  }, [cancelCompaction])

  const handleRewindTo = useCallback((toSeq: number) => void rewindTo(toSeq), [rewindTo])

  const settle = useCallback(() => setProgress(IDLE_PROGRESS), [])

  return {
    working,
    progress,
    drive,
    handleInterrupt,
    handleRetry,
    handleResume,
    handleResumeFresh,
    handleRewindTo,
    isResumable: isResumable(events),
    settle,
  }
}
