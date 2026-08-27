import {
  contextTokens,
  type BranchId,
  type Event,
  type ModelUsage,
} from '@dltech/atlas-core'
import { ETurnStatus, type TurnOutcome } from '@dltech/atlas-harness'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import {
  createConversationStore,
  type EThinkingVisibility,
  type PendingMessage,
  type SidebarModel,
  type TranscriptModel,
} from '../store'
import type { TurnClock } from '../ui/components/transcript'
import type { AtlasApp } from './compose'
import type { OpenedConversation } from './open-conversation'
import { EUndo, undoTurn } from './undo-turn'
import {
  clockReadableAt,
  IDLE_PROGRESS,
  stoppageOf,
  transcriptOfTurn,
  turnAdvanced,
  turnInterrupting,
  turnSettled,
  turnStarted,
  type TurnProgress,
} from './turn-progress'

const CLOCK_TICK_MS = 250

const UNEXPLAINED = 'The turn stopped for a reason it did not name.'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : UNEXPLAINED)

const userSaid = (text: string) => ({ type: 'user-said' as const, text })

const committedNothing = (outcome: TurnOutcome): boolean =>
  outcome.status === ETurnStatus.Interrupted && !outcome.committed

export type Conversation = {
  branchId: BranchId
  model: TranscriptModel
  sidebar: SidebarModel
  turn: TurnClock
  now: number
  working: boolean
  contextTokens: number
  pending: readonly PendingMessage[]
  handleSend: (text: string) => void
  handleTakeBackPending: () => string | null
  handleRetry: () => void
  handleInterrupt: () => void
  handleNewConversation: () => void
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
  const abort = useRef<AbortController | null>(null)

  const store = useMemo(
    () =>
      createConversationStore({
        channel: app.channel,
        branchId: opened.branchId,
        events: opened.events,
        paceReveal,
      }),
    [app.channel, paceReveal, opened],
  )

  useEffect(() => () => store.dispose(), [store])

  useEffect(() => store.setThinking(thinking), [store, thinking])

  const turn = progress.clock

  useEffect(() => store.setTurn(turn), [store, turn])

  const derived = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const sidebar = useSyncExternalStore(store.subscribe, store.getSidebar)

  const pending = app.pending
  const queued = useSyncExternalStore(pending.subscribe, pending.getSnapshot)

  const refresh = useCallback(async () => {
    const read: readonly Event[] = await app.log.read({ branchId: opened.branchId })
    store.setEvents(read)
    setEvents(read)
  }, [app.log, opened.branchId, store])

  useEffect(
    () =>
      app.channel.subscribe({
        branchId: opened.branchId,
        listener: (signal) => {
          setProgress((current) => turnAdvanced({ progress: current, signal }))
          if (signal.type === 'chunk' && signal.chunk.type === 'finish') {
            const usage = signal.chunk.usage
            if (usage !== undefined) setReported(usage)
          }
          if (signal.type === 'step-ended') void refresh()
        },
      }),
    [app.channel, opened.branchId, refresh],
  )

  const streaming = derived.streaming || working
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!streaming) return

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [streaming])

  const undo = useCallback(async () => {
    const undone = await undoTurn({
      log: app.log,
      branches: app.branches,
      branchId: opened.branchId,
    })

    if (undone.type === EUndo.Refused) {
      setFailure(undone.reason)
      return
    }
    if (undone.type === EUndo.Nothing) return

    await refresh()
    onUndone(undone.text)
  }, [app.branches, app.log, onUndone, opened.branchId, refresh])

  const drive = useCallback(
    (drafts: readonly { type: 'user-said'; text: string }[]) => {
      const controller = new AbortController()

      abort.current = controller
      setWorking(true)
      setFailure(null)
      setProgress(turnStarted({ now: Date.now() }))

      void (async () => {
        try {
          if (drafts.length > 0) {
            await app.log.append({
              branchId: opened.branchId,
              runId: app.ids.nextRunId(),
              drafts,
            })
            await refresh()
          }
          const outcome = await app.runner.runTurn({
            branchId: opened.branchId,
            signal: controller.signal,
          })
          setFailure(stoppageOf(outcome))
          if (committedNothing(outcome)) await undo()
        } catch (error) {
          setFailure(messageOf(error))
        } finally {
          abort.current = null
          setWorking(false)
          setProgress((current) => turnSettled({ progress: current, now: Date.now() }))
          await refresh().catch(() => undefined)
        }
      })()
    },
    [app, opened.branchId, refresh, undo],
  )

  const handleSend = useCallback(
    (text: string) => {
      const said = text.trim()
      if (said.length === 0) return

      if (working) {
        pending.enqueue({ text: said })
        return
      }

      drive([...pending.drain(), said].map(userSaid))
    },
    [drive, pending, working],
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
    void app.branches.create({}).then((branch) => {
      setProgress(IDLE_PROGRESS)
      setFailure(null)
      setReported(null)
      setEvents([])
      setOpened({ branchId: branch.id, events: [] })
    })
  }, [app.branches, pending, working])

  const used = useMemo(() => contextTokens({ reported, events }), [reported, events])

  const model = transcriptOfTurn({ model: derived, working, failure })

  return {
    branchId: opened.branchId,
    model,
    sidebar,
    turn,
    now: clockReadableAt({ now, clock: turn }),
    working,
    contextTokens: used,
    pending: queued,
    handleSend,
    handleTakeBackPending,
    handleRetry,
    handleInterrupt,
    handleNewConversation,
  }
}
