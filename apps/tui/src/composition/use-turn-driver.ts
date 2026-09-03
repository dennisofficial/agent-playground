import {
  isResumable,
  resumeDrafts,
  rowsOwnedBy,
  type Event,
  type EventDraft,
  type EventLogPort,
  type ModelUsage,
  type ThreadId,
} from '@dltech/atlas-core'
import { ETurnStatus, rewindThread, type TurnOutcome } from '@dltech/atlas-harness'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import { FRAME_MS, type ConversationStore } from '../store'
import { unansweredApproval, type ApprovalQuestion } from '../ui/approval-model'
import { useApproval, type ApprovalControl } from './use-approval'
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
  approval: ApprovalControl
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
  const characters = useRef(0)
  const latest = useRef<TurnProgress>(IDLE_PROGRESS)
  const clockFrame = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const publishProgress = useCallback((next: TurnProgress) => {
    latest.current = next
    if (clockFrame.current !== undefined) {
      clearTimeout(clockFrame.current)
      clockFrame.current = undefined
    }
    setProgress(next)
  }, [])

  const flushClock = useCallback(() => {
    clockFrame.current = undefined
    setProgress(latest.current)
  }, [])

  useEffect(
    () => () => {
      if (clockFrame.current !== undefined) clearTimeout(clockFrame.current)
    },
    [],
  )
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

  useEffect(
    () =>
      app.channel.subscribe({
        threadId,
        listener: (signal) => {
          const next = turnAdvanced({
            progress: { characters: characters.current, clock: latest.current.clock },
            signal,
            now: readClock(),
          })
          characters.current = next.characters

          if (next.clock === latest.current.clock) {
            // No visible change.
          } else if (signal.type === 'chunk') {
            latest.current = next
            if (clockFrame.current === undefined) {
              clockFrame.current = setTimeout(flushClock, FRAME_MS)
            }
          } else {
            publishProgress(next)
          }
          if (signal.type === 'chunk' && signal.chunk.type === 'finish') {
            const usage = signal.chunk.usage
            if (usage !== undefined) args.onUsage(usage)
          }
          if (signal.type === 'step-ended' || signal.type === 'events-appended') void refresh()
        },
      }),
    [app, threadId, refresh, readClock, flushClock, publishProgress],
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
      const started = turnStarted({ now: readClock() })
      characters.current = started.characters
      publishProgress(started)

      void (async () => {
        try {
          if (drafts.length > 0) {
            await commit(drafts)
            await refresh()
          }
          gate.settle()
          const outcome = await app.runner.runTurn({ threadId, signal: controller.signal })
          const asked = await pausedOnApproval({ log: app.log, threadId, outcome })
          if (asked === null) setFailure(stoppageOf(outcome))
          else openApproval(asked)
          if (committedNothing(outcome)) await undo()
        } catch (error) {
          setFailure(messageOf(error))
        } finally {
          gate.settle()
          abort.current = null
          setWorking(false)
          const settledTurn = turnSettled({
            progress: { characters: characters.current, clock: latest.current.clock },
            now: readClock(),
          })
          characters.current = settledTurn.characters
          publishProgress(settledTurn)
          await refresh().catch(() => undefined)
          await compactIfFull(used.current).catch(() => undefined)
        }
      })()

      return gate.reached
    },
    [
      app,
      commit,
      compactIfFull,
      openApproval,
      publishProgress,
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

    publishProgress(turnInterrupting(latest.current))
    controller.abort()
  }, [cancelCompaction])

  const handleRewindTo = useCallback((toSeq: number) => void rewindTo(toSeq), [rewindTo])

  const settle = useCallback(() => {
    characters.current = IDLE_PROGRESS.characters
    publishProgress(IDLE_PROGRESS)
  }, [publishProgress])

  return {
    working,
    approval,
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
