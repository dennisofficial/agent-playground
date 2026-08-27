import {
  contextTokens,
  eventsOfType,
  type ThreadId,
  type Event,
  type ModelUsage,
} from '@dltech/atlas-core'
import { ETurnStatus, type TurnOutcome } from '@dltech/atlas-harness'
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
import type { TurnClock } from '../ui/components/transcript'
import type { AtlasApp } from './compose'
import type { OpenedConversation } from './open-conversation'
import { compactTurn, ECompaction, recencyBudgetFor } from './compact-turn'
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
  pending: readonly PendingRow[]
  handleSend: (text: string) => void
  handleTakeBackPending: () => string | null
  handleRetry: (() => void) | null
  handleInterrupt: () => void
  handleNewConversation: () => void
  handleCompact: () => void
}

export function useConversation(args: {
  app: AtlasApp
  opened: OpenedConversation
  paceReveal: boolean
  thinking: EThinkingVisibility
  onUndone: (text: string) => void
}): Conversation {
  const { app, paceReveal, thinking, onUndone } = args
  const [opened, setOpened] = useState<OpenedConversation>(args.opened)
  const [progress, setProgress] = useState<TurnProgress>(IDLE_PROGRESS)
  const [failure, setFailure] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [events, setEvents] = useState<readonly Event[]>(args.opened.events)
  const [reported, setReported] = useState<ModelUsage | null>(null)
  const [name, setName] = useState<string | null>(args.opened.name)
  const abort = useRef<AbortController | null>(null)
  const asked = useRef<ThreadId | null>(null)

  const store = useMemo(
    () =>
      createConversationStore({
        channel: app.channel,
        threadId: opened.threadId,
        events: opened.events,
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
    const read: readonly Event[] = await app.log.read({ threadId: opened.threadId })
    store.setEvents(read)
    setEvents(read)
    pending.settleTaken({ landed: trailingSaid(read) })
  }, [app.log, opened.threadId, pending, store])

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

  useEffect(() => {
    if (!streaming) return

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
  }, [readClock, streaming])

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

  const compact = useCallback(async () => {
    const compaction = await compactTurn({
      log: app.log,
      threads: app.threads,
      threadId: opened.threadId,
      keepRecentTokens: recencyBudgetFor(app.model.choice().modelId),
      summarise: app.summarise,
    })

    if (compaction.type === ECompaction.Refused) {
      setFailure(compaction.reason)
      return
    }
    if (compaction.type === ECompaction.Nothing) return

    setReported(null)
    await refresh()
  }, [app.threads, app.log, app.model, app.summarise, opened.threadId, refresh])

  const drive = useCallback(
    (drafts: readonly { type: 'user-said'; text: string }[]) => {
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
        }
      })()
    },
    [app, opened.threadId, readClock, refresh, store, undo],
  )

  /**
   * A background shell that ends while nothing is running has no turn to be delivered into, so the
   * ending is what starts one. Mid-turn there is nothing to do: the loop drains the same queue on
   * its next pass. The witness keeps a turn that dies before its first drain from spinning here.
   */
  const woken = useRef<string | null>(null)

  useEffect(() => {
    if (notices.length === 0) {
      woken.current = null
      return
    }
    if (working) return

    const witness = notices.map((notice) => notice.shellId).join(' ')
    if (woken.current === witness) return

    woken.current = witness
    drive([])
  }, [drive, notices, working])

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
    (text: string) => {
      const said = text.trim()
      if (said.length === 0) return

      nameSession(said)

      if (working) {
        pending.enqueue({ text: said })
        return
      }

      drive([...pending.drain(), said].map(userSaid))
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

  const handleInterrupt = useCallback(() => {
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
      setOpened({ threadId: thread.id, events: [], name: null })
    })
  }, [app.threads, pending, working])

  const used = useMemo(() => contextTokens({ reported, events }), [reported, events])

  const rows = useMemo(() => pendingRows({ messages: queued, notices }), [notices, queued])

  const model = transcriptOfTurn({ model: derived, working, failure })
  const retryable = model.failure !== null && !working

  return {
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
    handleInterrupt,
    handleNewConversation,
    handleCompact: () => void compact(),
  }
}
