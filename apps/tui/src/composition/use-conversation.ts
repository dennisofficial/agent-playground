import type { BranchId } from '@dltech/atlas-core'
import { ETurnStatus } from '@dltech/atlas-harness'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { createConversationStore, type TranscriptModel } from '../store'
import type { TurnClock } from '../ui/components/transcript'
import type { AtlasApp } from './compose'
import type { OpenedConversation } from './open-conversation'
import {
  clockReadableAt,
  IDLE_PROGRESS,
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

export type Conversation = {
  branchId: BranchId
  model: TranscriptModel
  turn: TurnClock
  now: number
  working: boolean
  handleSend: (text: string) => void
  handleInterrupt: () => void
  handleNewConversation: () => void
}

export function useConversation(args: {
  app: AtlasApp
  opened: OpenedConversation
}): Conversation {
  const { app } = args
  const [opened, setOpened] = useState<OpenedConversation>(args.opened)
  const [progress, setProgress] = useState<TurnProgress>(IDLE_PROGRESS)
  const [failure, setFailure] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const abort = useRef<AbortController | null>(null)

  const store = useMemo(
    () =>
      createConversationStore({
        channel: app.channel,
        branchId: opened.branchId,
        events: opened.events,
      }),
    [app.channel, opened],
  )

  useEffect(() => () => store.dispose(), [store])

  const derived = useSyncExternalStore(store.subscribe, store.getSnapshot)

  const refresh = useCallback(async () => {
    store.setEvents(await app.log.read({ branchId: opened.branchId }))
  }, [app.log, opened.branchId, store])

  useEffect(
    () =>
      app.channel.subscribe({
        branchId: opened.branchId,
        listener: (signal) => {
          setProgress((current) => turnAdvanced({ progress: current, signal }))
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

  const handleSend = useCallback(
    (text: string) => {
      if (working) return

      const said = text.trim()
      if (said.length === 0) return

      const controller = new AbortController()

      abort.current = controller
      setWorking(true)
      setFailure(null)
      setProgress(turnStarted({ now: Date.now() }))

      void (async () => {
        try {
          await app.log.append({
            branchId: opened.branchId,
            runId: app.ids.nextRunId(),
            drafts: [{ type: 'user-said', text: said }],
          })
          await refresh()
          const outcome = await app.runner.runTurn({
            branchId: opened.branchId,
            signal: controller.signal,
          })
          if (outcome.status === ETurnStatus.Failed) setFailure(outcome.message)
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
    [app, opened.branchId, refresh, working],
  )

  const handleInterrupt = useCallback(() => {
    const controller = abort.current
    if (controller === null) return

    setProgress(turnInterrupting)
    controller.abort()
  }, [])

  const handleNewConversation = useCallback(() => {
    if (working) return

    void app.branches.create({}).then((branch) => {
      setProgress(IDLE_PROGRESS)
      setFailure(null)
      setOpened({ branchId: branch.id, events: [] })
    })
  }, [app.branches, working])

  const model = transcriptOfTurn({ model: derived, working, failure })

  return {
    branchId: opened.branchId,
    model,
    turn: progress.clock,
    now: clockReadableAt({ now, clock: progress.clock }),
    working,
    handleSend,
    handleInterrupt,
    handleNewConversation,
  }
}
