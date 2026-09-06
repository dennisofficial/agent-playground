import {
  isResumable,
  resumeDrafts,
  rowsOwnedBy,
  type EventDraft,
  type EventLogPort,
  type ThreadId,
} from '@dltech/atlas-core'
import { ETurnStatus, rewindThread, type TurnOutcome } from '@dltech/atlas-harness'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import { unansweredApproval, type ApprovalQuestion } from '../ui/approval-model'
import { ENoticeTone, NOTICE_WARN_MS, notify } from '../ui/notice-store'
import { useApproval, type ApprovalControl } from './use-approval'
import type { AtlasApp } from './compose'
import { discardInterrupted, EDiscard } from './resume-turn'
import { EUndo, undoTurn } from './undo-turn'
import type { ThreadView } from './use-thread-view'
import {
  IDLE_PROGRESS,
  stoppageOf,
  turnInterrupting,
  turnSettled,
  turnStarted,
} from './turn-progress'

const UNEXPLAINED = 'The turn stopped for a reason it did not name.'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : UNEXPLAINED)

const committedNothing = (outcome: TurnOutcome): boolean =>
  outcome.status === ETurnStatus.Interrupted && !outcome.committed

async function pausedOnApproval(args: {
  log: EventLogPort
  threadId: ThreadId
  outcome: TurnOutcome
}): Promise<ApprovalQuestion | null> {
  if (args.outcome.status !== ETurnStatus.Paused) return null

  const events = await args.log.read({ threadId: args.threadId })
  return unansweredApproval({
    events: rowsOwnedBy({ events, threadId: args.threadId }),
    callId: args.outcome.callId,
  })
}

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
  workingRef: RefObject<boolean>
  approval: ApprovalControl
  drive: (drafts: readonly EventDraft[]) => Promise<void>
  handleInterrupt: () => void
  handleRetry: () => void
  handleResume: () => void
  handleResumeFresh: () => void
  handleRewindTo: (toSeq: number) => void
  isResumable: boolean
  settle: () => void
}

/**
 * What it takes to run a turn on the thread on screen. The clock it runs against belongs to the
 * view, not to this: a turn nobody drove from here still has to read as one, so `stamp` is how a
 * keystroke reports what the channel cannot say — that a turn began before its first signal, that
 * an interrupt is pending, that a run has settled.
 */
export function useTurnDriver(args: {
  app: AtlasApp
  threadId: ThreadId
  started: RefObject<boolean>
  view: ThreadView
  readClock: () => number
  used: RefObject<number>
  compactIfFull: (used: number) => Promise<void>
  cancelCompaction: () => boolean
  onSettled: () => Promise<void>
  onUndone: (text: string) => void
  setFailure: (reason: string | null) => void
  forgetUsage: () => void
}): TurnDriver {
  const { app, threadId, started, view, readClock, used, compactIfFull } = args
  const { cancelCompaction, onSettled, onUndone, setFailure, forgetUsage } = args
  const { store, events, refresh, stamp } = view

  const [working, setWorking] = useState(false)
  const workingRef = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const driveLatest = useRef<(drafts: readonly EventDraft[]) => Promise<void>>(async () => undefined)

  const handleAnswered = useCallback((drafts: readonly EventDraft[]) => {
    void driveLatest.current(drafts)
  }, [])

  const approval = useApproval({ onAnswer: handleAnswered })
  const { handleOpen: openApproval } = approval

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
      workingRef.current = true
      setWorking(true)
      setFailure(null)
      store.supersedeFailure()
      stamp(() => turnStarted({ now: readClock() }))

      void (async () => {
        let pausedForApproval = false
        try {
          if (drafts.length > 0) {
            await commit(drafts)
            await refresh()
          }
          gate.settle()
          const outcome = await app.runner.runTurn({ threadId, signal: controller.signal })
          const asked = await pausedOnApproval({ log: app.log, threadId, outcome })
          if (asked === null) setFailure(stoppageOf(outcome))
          else {
            pausedForApproval = true
            openApproval(asked)
          }
          if (committedNothing(outcome)) await undo()
        } catch (error) {
          setFailure(messageOf(error))
        } finally {
          gate.settle()
          abort.current = null
          workingRef.current = false
          stamp((current) => turnSettled({ progress: current, now: readClock() }))
          await refresh().catch(() => undefined)
          if (!pausedForApproval) await onSettled().catch(() => undefined)
          setWorking(false)
          await compactIfFull(used.current).catch(() => undefined)
        }
      })()

      return gate.reached
    },
    [
      app,
      commit,
      compactIfFull,
      onSettled,
      openApproval,
      readClock,
      refresh,
      setFailure,
      store,
      threadId,
      undo,
      used,
    ],
  )

  useEffect(() => {
    driveLatest.current = drive
  }, [drive])

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
      if (abort.current !== null) {
        notify({
          key: 'rewind-mid-turn',
          tone: ENoticeTone.Warn,
          ttlMs: NOTICE_WARN_MS,
          text: '/rewind has to wait for this turn — pick the point again when it settles',
        })
        return
      }

      cancelCompaction()
      workingRef.current = true
      setWorking(true)
      try {
        const rewound = await rewindThread({ log: app.log, threads: app.threads, threadId, toSeq })

        if (!rewound.ok) {
          setFailure(rewound.reason)
          return
        }
        store.resetSteps()
        forgetUsage()
        await refresh()
      } finally {
        workingRef.current = false
        setWorking(false)
      }
    },
    [app.log, app.threads, cancelCompaction, forgetUsage, refresh, setFailure, store, threadId],
  )

  /**
   * One key stops whatever is running, and a compaction is not a turn — so the compaction is
   * offered the press first and the turn only aborts if it was not taken.
   */
  const handleInterrupt = useCallback(() => {
    if (cancelCompaction()) return

    const controller = abort.current
    if (controller === null) return

    stamp(turnInterrupting)
    controller.abort()
  }, [cancelCompaction, stamp])

  const handleRewindTo = useCallback((toSeq: number) => void rewindTo(toSeq), [rewindTo])

  const settle = useCallback(() => stamp(() => IDLE_PROGRESS), [stamp])

  return {
    working,
    workingRef,
    approval,
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
