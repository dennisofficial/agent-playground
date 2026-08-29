import {
  autoCompactAfterTurn,
  contextTokens,
  EAutoCompact,
  ECompactionAnchor,
  modelEntry,
  eventsOfType,
  isResumable,
  resumeDrafts,
  sessionDirectoryOf,
  type ThreadId,
  type Event,
  type EventDraft,
  type ModelUsage,
} from '@dltech/atlas-core'
import { ETurnStatus, rewindThread, type TurnOutcome } from '@dltech/atlas-harness'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import {
  createConversationStore,
  pendingRows,
  trailingSaid,
  type EThinkingVisibility,
  type PendingRow,
  type SidebarModel,
  type TranscriptModel,
} from '../store'
import type { Compacting } from '../ui/components/compacting'
import type { TurnClock } from '../ui/components/transcript'
import type { AtlasApp } from './compose'
import type { OpenedConversation } from './open-conversation'
import {
  summariseAt,
  compactTurn,
  ECompaction,
  ECompactScope,
  type Compaction,
} from './compact-turn'
import { discardInterrupted, EDiscard } from './resume-turn'
import { EUndo, undoTurn } from './undo-turn'
import {
  awakeAt,
  clockReadableAt,
  IDLE_PROGRESS,
  stoppageOf,
  suspensionFrom,
  suspensionTicked,
  transcriptOfTurn,
  turnAdvanced,
  turnInterrupting,
  turnSettled,
  turnStarted,
  type Suspension,
  type TurnProgress,
} from './turn-progress'

const CLOCK_TICK_MS = 250

const UNEXPLAINED = 'The turn stopped for a reason it did not name.'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : UNEXPLAINED)

const userSaid = (text: string) => ({ type: 'user-said' as const, text })

const COMPACTION_CRASHED = 'compacting the history did not finish, so nothing was changed'

const committedNothing = (outcome: TurnOutcome): boolean =>
  outcome.status === ETurnStatus.Interrupted && !outcome.committed

export type Conversation = {
  threadId: ThreadId
  model: TranscriptModel
  sidebar: SidebarModel
  turn: TurnClock
  now: number
  working: boolean
  contextTokens: number
  sessionDirectory: string
  pending: readonly PendingRow[]
  readEvents: () => readonly Event[]
  handleSend: (text: string, context?: readonly EventDraft[]) => void
  handleTakeBackPending: () => string | null
  handleRetry: (() => void) | null
  handleResume: (() => void) | null
  handleResumeFresh: (() => void) | null
  handleReportProblem: (reason: string) => void
  handleInterrupt: () => void
  compacting: Compacting | null
  handleNewConversation: () => void
  handleCompact: (scope: ECompactScope) => void
  handleCompactAround: (args: { anchor: ECompactionAnchor; seq: number }) => void
  handleRewindTo: (toSeq: number) => void
}

export function useConversation(args: {
  app: AtlasApp
  opened: OpenedConversation
  paceReveal: boolean
  autoCompactAtPercent: number
  thinking: EThinkingVisibility
  onUndone: (text: string) => void
  canWake: boolean
}): Conversation {
  const { app, paceReveal, thinking, onUndone } = args
  const [opened, setOpened] = useState<OpenedConversation>(args.opened)
  const [progress, setProgress] = useState<TurnProgress>(IDLE_PROGRESS)
  const [failure, setFailure] = useState<string | null>(null)
  const [compacting, setCompacting] = useState<Compacting | null>(null)
  const [working, setWorking] = useState(false)
  const [events, setEvents] = useState<readonly Event[]>(args.opened.events)
  const [reported, setReported] = useState<ModelUsage | null>(null)
  const [name, setName] = useState<string | null>(args.opened.name)
  const abort = useRef<AbortController | null>(null)
  const asked = useRef<ThreadId | null>(null)
  const usedRef = useRef(0)
  const compacter = useRef<AbortController | null>(null)

  const store = useMemo(
    () =>
      createConversationStore({
        channel: app.channel,
        threadId: opened.threadId,
        events: opened.events,
        turns: opened.turns,
        paceReveal,
        name: opened.name,
      }),
    [app.channel, paceReveal, opened],
  )

  useEffect(() => () => store.dispose(), [store])

  useEffect(() => app.markActiveThread(opened.threadId), [app, opened.threadId])

  useEffect(() => store.setName(name), [store, name])

  useEffect(() => store.setThinking(thinking), [store, thinking])

  const turn = progress.clock

  useEffect(() => store.setTurn(turn), [store, turn])

  const derived = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const sidebar = useSyncExternalStore(store.subscribe, store.getSidebar)

  const pending = app.pending
  const queued = useSyncExternalStore(pending.subscribe, pending.getSnapshot)

  const shells = app.shells
  const subscribeToShells = useCallback(
    (listener: () => void) => shells.onNotice(listener),
    [shells],
  )
  const readShellNotices = useCallback(() => shells.pendingNotices(), [shells])
  const notices = useSyncExternalStore(subscribeToShells, readShellNotices)

  const refresh = useCallback(async () => {
    const [read, spent] = await Promise.all([
      app.log.read({ threadId: opened.threadId }),
      app.ledger.forThread({ threadId: opened.threadId }),
    ])
    store.setEvents({ events: read, turns: spent })
    setEvents(read)
    pending.settleTaken({ landed: trailingSaid(read) })
  }, [app.ledger, app.log, opened.threadId, pending, store])

  useEffect(
    () =>
      app.channel.subscribe({
        threadId: opened.threadId,
        listener: (signal) => {
          setProgress((current) => turnAdvanced({ progress: current, signal }))
          if (signal.type === 'chunk' && signal.chunk.type === 'finish') {
            const usage = signal.chunk.usage
            if (usage !== undefined) setReported(usage)
          }
          if (signal.type === 'step-ended' || signal.type === 'events-appended') void refresh()
        },
      }),
    [app.channel, opened.threadId, refresh],
  )

  const streaming = derived.streaming || working
  const suspension = useRef<Suspension>(suspensionFrom({ now: Date.now() }))
  const readClock = useCallback(
    () => awakeAt({ suspension: suspension.current, now: Date.now() }),
    [],
  )
  const [now, setNow] = useState(readClock)

  const ticking = streaming || compacting !== null

  useEffect(() => {
    if (!ticking) return

    suspension.current = suspensionFrom({
      now: Date.now(),
      suspendedMs: suspension.current.suspendedMs,
    })
    setNow(readClock())

    const timer = setInterval(() => {
      suspension.current = suspensionTicked({
        suspension: suspension.current,
        now: Date.now(),
        intervalMs: CLOCK_TICK_MS,
      })
      setNow(readClock())
    }, CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [readClock, ticking])

  const undo = useCallback(async () => {
    const undone = await undoTurn({
      log: app.log,
      threads: app.threads,
      threadId: opened.threadId,
    })

    if (undone.type === EUndo.Refused) {
      setFailure(undone.reason)
      return
    }
    if (undone.type === EUndo.Nothing) return

    await refresh()
    onUndone(undone.text)
  }, [app.threads, app.log, onUndone, opened.threadId, refresh])

  const settleCompaction = useCallback(
    async (compaction: Compaction) => {
      if (compaction.type === ECompaction.Refused) {
        setFailure(compaction.reason)
        return
      }
      if (compaction.type === ECompaction.Nothing) return

      setReported(null)
      await refresh()
    },
    [refresh],
  )

  const runCompaction = useCallback(
    async (start: (signal: AbortSignal) => Promise<Compaction>): Promise<void> => {
      if (compacter.current !== null) return

      const controller = new AbortController()
      compacter.current = controller
      setCompacting({ startedAt: readClock(), cancelling: false })

      try {
        const outcome = await start(controller.signal)
        if (!controller.signal.aborted) await settleCompaction(outcome)
      } catch {
        if (!controller.signal.aborted) setFailure(COMPACTION_CRASHED)
      } finally {
        compacter.current = null
        setCompacting(null)
      }
    },
    [readClock, settleCompaction],
  )

  const compact = useCallback(
    (scope: ECompactScope) =>
      runCompaction((signal) =>
        compactTurn({
          log: app.log,
          threads: app.threads,
          threadId: opened.threadId,
          scope,
          summarise: app.summarise,
          signal,
        }),
      ),
    [app.threads, app.log, app.summarise, opened.threadId, runCompaction],
  )

  const compactAround = useCallback(
    (args: { anchor: ECompactionAnchor; seq: number }) =>
      runCompaction((signal) =>
        summariseAt({
          log: app.log,
          threads: app.threads,
          threadId: opened.threadId,
          anchor: args.anchor,
          seq: args.seq,
          summarise: app.summarise,
          signal,
        }),
      ),
    [app.threads, app.log, app.summarise, opened.threadId, runCompaction],
  )

  const rewindTo = useCallback(
    async (toSeq: number) => {
      const rewound = await rewindThread({
        log: app.log,
        threads: app.threads,
        threadId: opened.threadId,
        toSeq,
      })

      if (!rewound.ok) {
        setFailure(rewound.reason)
        return
      }
      setReported(null)
      await refresh()
    },
    [app.threads, app.log, opened.threadId, refresh],
  )

  const compactIfFull = useCallback(async () => {
    const window = modelEntry(app.model.choice().modelId)?.contextWindow ?? 0
    const decision = autoCompactAfterTurn({
      used: usedRef.current,
      window,
      atPercent: args.autoCompactAtPercent,
    })
    if (decision === EAutoCompact.Hold) return

    await runCompaction((signal) =>
      compactTurn({
        log: app.log,
        threads: app.threads,
        threadId: opened.threadId,
        summarise: app.summarise,
        signal,
      }),
    )
  }, [app, args.autoCompactAtPercent, opened.threadId, runCompaction])

  const drive = useCallback(
    (drafts: readonly EventDraft[]) => {
      const controller = new AbortController()

      abort.current = controller
      setWorking(true)
      setFailure(null)
      store.supersedeFailure()
      setProgress(turnStarted({ now: readClock() }))

      void (async () => {
        try {
          if (drafts.length > 0) {
            await app.log.append({
              threadId: opened.threadId,
              runId: app.ids.nextRunId(),
              drafts,
            })
            await refresh()
          }
          const outcome = await app.runner.runTurn({
            threadId: opened.threadId,
            signal: controller.signal,
          })
          setFailure(stoppageOf(outcome))
          if (committedNothing(outcome)) await undo()
        } catch (error) {
          setFailure(messageOf(error))
        } finally {
          abort.current = null
          setWorking(false)
          setProgress((current) => turnSettled({ progress: current, now: readClock() }))
          await refresh().catch(() => undefined)
          await compactIfFull().catch(() => undefined)
        }
      })()
    },
    [app, opened.threadId, readClock, refresh, store, undo],
  )

  /**
   * A background shell that ends while nothing is running has no turn to be delivered into, so the
   * ending is what starts one. Mid-turn there is nothing to do: the loop drains the same queue on
   * its next pass. The witness keeps a turn that dies before its first drain from spinning here.
   *
   * A turn must not start behind a prompt that has taken the keyboard, so an overlay waiting on an
   * answer holds the wake off until it is closed. The ending keeps until then.
   */
  const woken = useRef<string | null>(null)

  useEffect(() => {
    if (notices.length === 0) {
      woken.current = null
      return
    }
    if (working || !args.canWake) return

    const witness = notices.map((notice) => notice.shellId).join(' ')
    if (woken.current === witness) return

    woken.current = witness
    drive([])
  }, [args.canWake, drive, notices, working])

  const nameSession = useCallback(
    (said: string) => {
      if (name !== null || asked.current === opened.threadId) return

      asked.current = opened.threadId
      const opening = eventsOfType({ events, type: 'user-said' }).at(0)?.text ?? said

      void app
        .titler({ text: opening })
        .then((named) => {
          if (named === null) return
          setName(named)
          return app.threads.rename({ threadId: opened.threadId, title: named })
        })
        .catch(() => undefined)
    },
    [app, events, name, opened.threadId],
  )

  const handleSend = useCallback(
    (text: string, context: readonly EventDraft[] = []) => {
      const said = text.trim()
      if (said.length === 0) return

      nameSession(said)

      if (working) {
        pending.enqueue({ text: said })
        return
      }

      drive([...context, ...[...pending.drain(), said].map(userSaid)])
    },
    [drive, nameSession, pending, working],
  )

  const handleTakeBackPending = useCallback(() => pending.takeBackLast()?.text ?? null, [pending])

  /**
   * A failed turn leaves its events durable, so retrying is the same turn run again with nothing
   * appended — the loop picks up from the last event rather than replaying what already landed.
   */
  const handleRetry = useCallback(() => {
    if (working) return
    drive([])
  }, [drive, working])

  const handleResume = useCallback(() => {
    if (working) return
    drive(resumeDrafts(events))
  }, [drive, events, working])

  const handleResumeFresh = useCallback(() => {
    if (working) return

    void (async () => {
      const discarded = await discardInterrupted({
        log: app.log,
        threads: app.threads,
        threadId: opened.threadId,
      })

      if (discarded.type === EDiscard.Refused) {
        setFailure(discarded.reason)
        return
      }

      setReported(null)
      await refresh()
      drive([])
    })()
  }, [app.log, app.threads, drive, opened.threadId, refresh, working])

  const handleInterrupt = useCallback(() => {
    const compacter_ = compacter.current
    if (compacter_ !== null) {
      setCompacting((current) => (current === null ? null : { ...current, cancelling: true }))
      compacter_.abort()
      return
    }

    const controller = abort.current
    if (controller === null) return

    setProgress(turnInterrupting)
    controller.abort()
  }, [])

  const handleNewConversation = useCallback(() => {
    if (working) return

    pending.clear()
    app.shells.forgetNotices()
    void app.threads.create({}).then((thread) => {
      setProgress(IDLE_PROGRESS)
      setFailure(null)
      setReported(null)
      setEvents([])
      setName(null)
      setOpened({ threadId: thread.id, events: [], turns: [], name: null })
    })
  }, [app.threads, pending, working])

  const handleCompact = useCallback((scope: ECompactScope) => void compact(scope), [compact])

  const handleCompactAround = useCallback(
    (args: { anchor: ECompactionAnchor; seq: number }) => void compactAround(args),
    [compactAround],
  )

  const handleRewindTo = useCallback((toSeq: number) => void rewindTo(toSeq), [rewindTo])

  const readEvents = useCallback((): readonly Event[] => events, [events])

  const used = useMemo(() => contextTokens({ reported, events }), [reported, events])

  const sessionDirectory = useMemo(
    () => sessionDirectoryOf({ events, projectDirectory: app.config.cwd }),
    [events, app.config.cwd],
  )
  usedRef.current = used

  const rows = useMemo(() => pendingRows({ messages: queued, notices }), [notices, queued])

  const model = transcriptOfTurn({ model: derived, working, failure })
  const retryable = model.failure !== null && !working
  const resumable = model.failure === null && !working && isResumable(events)

  return {
    sessionDirectory,
    threadId: opened.threadId,
    model,
    sidebar,
    turn,
    now: clockReadableAt({ now, clock: turn }),
    working,
    contextTokens: used,
    pending: rows,
    handleSend,
    handleTakeBackPending,
    handleRetry: retryable ? handleRetry : null,
    handleResume: resumable ? handleResume : null,
    handleResumeFresh: resumable ? handleResumeFresh : null,
    readEvents,
    compacting,
    handleReportProblem: setFailure,
    handleInterrupt,
    handleNewConversation,
    handleCompact,
    handleCompactAround,
    handleRewindTo,
  }
}
