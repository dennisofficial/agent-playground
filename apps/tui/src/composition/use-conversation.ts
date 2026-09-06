import {
  activeWorktreeOf,
  contextTokens,
  ECompactionAnchor,
  projectDirectoryOf,
  treeMutationsOf,
  type ActiveWorktree,
  type ThreadId,
  type Event,
  type EventDraft,
  type ModelUsage,
  type SaidImage,
  type EExecutionLocation,
} from '@dltech/atlas-core'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import {
  pendingRows,
  type EThinkingVisibility,
  type PendingRow,
  type PendingSaid,
  type SidebarModel,
  type TranscriptModel,
} from '../store'
import type { Compacting } from '../ui/components/compacting'
import type { TurnClock } from '../ui/turn-clock'
import { publishProjections } from '../plugins/projection'
import { ENoticeTone, NOTICE_WARN_MS, notify } from '../ui/notice-store'
import { createAwakeClock } from './awake-clock'
import { droppedNotice, type QueuedSettled } from './commands'
import { ECommandEffect } from './commands/local-command'
import type { AtlasApp } from './compose'
import type { OpenedConversation } from './open-conversation'
import type { RecoveredAgents, ThreadModel } from '@dltech/atlas-harness'
import { ECompactScope } from './compact-turn'
import { useRevokeGrant } from './revoke-grant'
import type { Renaming } from './session-rename'
import { retractTrailingSaid } from './take-back'
import { terminalTitleSequence } from './terminal-title'
import { threadHandle } from './thread-slug'
import { userSaidDraft } from './user-said'
import { useCompaction } from './use-compaction'
import { useDelegatedToolCalls } from '../ui/hooks/use-delegated-tool-calls'
import { useSessionName } from './use-session-name'
import { useAgentWake } from './use-agent-wake'
import { useServiceWake } from './use-service-wake'
import { useShellWake } from './use-shell-wake'
import { EThreadRows, useThreadView, type ThreadSeed } from './use-thread-view'
import { useThreadSwap } from './use-thread-swap'
import type { ApprovalControl } from './use-approval'
import { useTurnDriver } from './use-turn-driver'
import { useTickingNow } from './use-turn-clock'
import { clockReadableAt, transcriptOfTurn } from './turn-progress'

const NO_IMAGES: readonly SaidImage[] = Object.freeze([])

const ALREADY_OPEN = Promise.resolve()

export type Conversation = {
  threadId: ThreadId
  started: boolean
  threadModel: ThreadModel | undefined
  executionLocation: EExecutionLocation | undefined
  approval: ApprovalControl
  lost: RecoveredAgents | null
  handle: string | null
  model: TranscriptModel
  sidebar: SidebarModel
  turn: TurnClock
  now: number
  working: boolean
  mutations: number
  contextTokens: number
  projectDirectory: string
  activeWorktree: ActiveWorktree | null
  pending: readonly PendingRow[]
  readEvents: () => readonly Event[]
  handleSend: (args: {
    text: string
    images?: readonly SaidImage[]
    context?: readonly EventDraft[]
  }) => void
  handleQueueSettled: (entry: QueuedSettled) => void
  handleTakeBackPending: () => Promise<PendingSaid | null> | null
  handleRetry: (() => void) | null
  handleResume: (() => void) | null
  handleReportProblem: (reason: string) => void
  handleInterrupt: () => void
  compacting: Compacting | null
  handleNewConversation: () => void
  handleOpenThread: (threadId: string) => void
  handleRename: (argumentText: string) => Promise<Renaming>
  handleCompact: (scope: ECompactScope) => void
  handleCompactAround: (args: { anchor: ECompactionAnchor; seq: number }) => void
  handleRewindTo: (toSeq: number) => void
  handleRevokeGrant: (grantId: string) => void
}

export function useConversation(args: {
  app: AtlasApp
  opened: OpenedConversation
  paceReveal: boolean
  autoCompactAtPercent: number
  thinking: EThinkingVisibility
  tldrStatus: boolean
  onUndone: (text: string) => void
  canWake: boolean
}): Conversation {
  const { app, paceReveal, thinking, tldrStatus, onUndone } = args
  const [opened, setOpened] = useState<OpenedConversation>(args.opened)
  const [failure, setFailure] = useState<string | null>(null)
  const [reported, setReported] = useState<ModelUsage | null>(null)
  const usedRef = useRef(0)
  const startedRef = useRef(args.opened.started)

  const forgetUsage = useCallback(() => setReported(null), [])

  const threadId = opened.threadId

  const clock = useMemo(() => createAwakeClock(), [])
  const readClock = clock.read

  const projectEvents = useCallback(
    ({ events: folded }: { events: readonly Event[] }) => {
      const broke = publishProjections({ projections: app.pluginProjections, events: folded })
      if (broke.length === 0) return

      notify({
        key: `projection:${broke.join(',')}`,
        tone: ENoticeTone.Warn,
        ttlMs: NOTICE_WARN_MS,
        text: `projection failed: ${broke.join(', ')}`,
      })
    },
    [app.pluginProjections],
  )

  const initial = useCallback(
    (): ThreadSeed => ({ events: opened.events, turns: opened.turns }),
    [opened],
  )

  const pending = useMemo(() => app.pending.forThread({ threadId }), [app.pending, threadId])

  /**
   * Settled commands wait in the same queue as the messages, but drain in the driver's own settle
   * path, before `working` flips: a wake or an auto-compaction reacting to the settle must find
   * the queued work already running, not beat it. A command that swaps the thread out strands the
   * commands queued behind it, so it says so and ends the drain.
   */
  const drainSettledCommands = useCallback(async (): Promise<void> => {
    const queuedCommands = pending.drainCommands()
    if (queuedCommands.length === 0) return

    for (const [index, entry] of queuedCommands.entries()) {
      const { command } = entry
      if (command.dropsQueue) {
        const dropped = droppedNotice({
          command: command.name,
          messages: command.losesWaiting
            ? pending
                .getSnapshot()
                .filter((one) => one.kind === 'message' && !one.taken).length
            : 0,
          commands: queuedCommands.slice(index + 1).map((one) => one.command.name),
        })
        if (dropped !== null) {
          notify({
            key: 'queued-dropped',
            text: dropped,
            tone: ENoticeTone.Warn,
            ttlMs: NOTICE_WARN_MS,
          })
        }
      }

      const effect = await command.run()
      if (effect.type === ECommandEffect.Refused) {
        notify({ text: effect.reason, tone: ENoticeTone.Warn, ttlMs: NOTICE_WARN_MS })
      } else if (effect.type === ECommandEffect.Ran && effect.notice !== undefined) {
        notify({ text: effect.notice })
      }

      if (command.dropsQueue) return
    }
  }, [pending])

  const handleQueueSettled = useCallback(
    (entry: QueuedSettled): void => {
      pending.enqueueCommand({ text: entry.text, command: entry })
    },
    [pending],
  )

  /**
   * The rows that landed settle the queue the operator typed ahead into — a concern of whoever owns
   * the composer, which is why the view reports the read rather than knowing what to do about it.
   */
  const afterRead = useCallback(
    (read: readonly Event[]) => pending.settleTaken({ events: read }),
    [pending],
  )

  const view = useThreadView({
    app,
    threadId,
    rows: EThreadRows.Composed,
    thinking,
    tldrStatus,
    readClock,
    initial,
    paceReveal,
    projectEvents,
    afterRead,
    onUsage: setReported,
  })

  const { store, events, setEvents, refresh } = view

  const handleRevokeGrant = useRevokeGrant({ app, threadId, refresh })

  const { name, setName, nameSession, renameSession } = useSessionName({
    app,
    threadId,
    started: startedRef,
    events,
    initial: args.opened.name,
  })

  const started = opened.started || events.length > 0

  useEffect(
    () => app.markActiveThread({ threadId, title: name, started }),
    [app, name, threadId, started],
  )

  useEffect(() => store.setName(name), [store, name])

  const derived = view.model
  const { sidebar } = view

  const queued = useSyncExternalStore(pending.subscribe, pending.getSnapshot)

  const compaction = useCompaction({
    app,
    threadId,
    atPercent: args.autoCompactAtPercent,
    readClock,
    refresh,
    onFailure: setFailure,
    onCompacted: forgetUsage,
  })

  const turnDriver = useTurnDriver({
    app,
    threadId,
    started: startedRef,
    view,
    readClock,
    used: usedRef,
    compactIfFull: compaction.compactIfFull,
    cancelCompaction: compaction.cancel,
    onSettled: drainSettledCommands,
    onUndone,
    setFailure,
    forgetUsage,
  })

  const { working, drive } = turnDriver
  const { compacting } = compaction
  const now = useTickingNow({
    ticking: derived.streaming || working || compacting !== null,
    clock,
  })

  const { turn } = view

  const handleWake = useCallback(() => void drive([]), [drive])

  const notices = useShellWake({
    shells: app.shells,
    threadId,
    working,
    canWake: args.canWake,
    onWake: handleWake,
  })

  const agentNotices = useAgentWake({
    agents: app.agents,
    threadId,
    working,
    canWake: args.canWake,
    onWake: handleWake,
  })

  const serviceNotices = useServiceWake({
    services: app.services,
    threadId,
    working,
    canWake: args.canWake,
    onWake: handleWake,
  })

  const handleSend = useCallback(
    (args: { text: string; images?: readonly SaidImage[]; context?: readonly EventDraft[] }) => {
      const text = args.text.trim()
      const images = args.images ?? NO_IMAGES
      if (text.length === 0) return

      if (working) {
        pending.enqueue({ text, images })
        nameSession({ said: text, opened: ALREADY_OPEN, images, context: args.context })
        return
      }

      const opened = drive([
        ...(args.context ?? []),
        ...[...pending.drain(), { text, images }].map(userSaidDraft),
      ])
      nameSession({ said: text, opened, images, context: args.context })
    },
    [drive, nameSession, pending, working],
  )

  const retraction = useRef<Promise<unknown>>(Promise.resolve(true))

  const handleTakeBackPending = useCallback((): Promise<PendingSaid | null> | null => {
    const last = pending.takeBackLast()
    if (last === null) return null
    if (!last.taken) return Promise.resolve(last)

    const retracted = retraction.current.then(() =>
      retractTrailingSaid({ log: app.log, threads: app.threads, agents: app.agents, threadId, text: last.text }),
    )
    retraction.current = retracted

    return retracted.then((retractedOk) => {
      if (!retractedOk) {
        notify({
          key: 'take-back-too-late',
          tone: ENoticeTone.Warn,
          ttlMs: NOTICE_WARN_MS,
          text: 'the agent is already answering that one — send the edit as a follow-up',
        })
        return null
      }

      refresh()
      return last
    })
  }, [app.log, app.threads, pending, refresh, threadId])

  /**
   * Shell endings are not dropped on the way out: they belong to the thread that started the shell,
   * so leaving one keeps its queue for when it is opened again.
   */
  const adopt = useCallback(
    (next: OpenedConversation) => {
      turnDriver.settle()
      setFailure(null)
      setReported(null)
      startedRef.current = next.started
      setEvents(next.events)
      setName(next.name)
      setOpened(next)
    },
    [setEvents, setName, turnDriver],
  )

  const { handleNewConversation, handleOpenThread } = useThreadSwap({
    app,
    threadId,
    working: turnDriver.workingRef,
    adopt,
    onFailure: setFailure,
  })

  /**
   * The visible conversation's directory is a plugin fact the turn hooks learn too late: a resumed
   * thread can sit in a worktree for hours before its first turn. Mounting and every adopt announce
   * it instead, so a surface that follows the session is right before anyone speaks.
   */
  useEffect(() => {
    void app.threadOpened({
      threadId: opened.threadId,
      projectDirectory: projectDirectoryOf({
        events: opened.events,
        launchDirectory: app.workspace.workspace,
      }),
    })
  }, [app, opened])

  const readEvents = useCallback((): readonly Event[] => events, [events])

  const used = useMemo(() => contextTokens({ reported, events }), [reported, events])

  const mutations = useMemo(
    () => treeMutationsOf({ events, effects: (name) => app.tools.find(name)?.effect }),
    [events, app.tools],
  )

  const delegatedToolCalls = useDelegatedToolCalls({ agents: app.agents, threadId })

  const workspace = useMemo((): {
    projectDirectory: string
    activeWorktree: ActiveWorktree | null
  } => {
    const launchDirectory = app.workspace.workspace
    return {
      projectDirectory: projectDirectoryOf({ events, launchDirectory }),
      activeWorktree: activeWorktreeOf(events) ?? null,
    }
  }, [events, app.workspace.workspace])
  usedRef.current = used

  useEffect(() => {
    process.stdout.write(
      terminalTitleSequence({ name, directory: workspace.projectDirectory }),
    )
  }, [name, workspace.projectDirectory])

  const rows = useMemo(
    () => pendingRows({ entries: queued, notices, agents: agentNotices, services: serviceNotices }),
    [agentNotices, notices, queued, serviceNotices],
  )

  const model = transcriptOfTurn({ model: derived, working, failure })
  const retryable = model.failure !== null && !working
  const resumable = model.failure === null && !working && turnDriver.isResumable

  return {
    approval: turnDriver.approval,
    projectDirectory: workspace.projectDirectory,
    activeWorktree: workspace.activeWorktree,
    threadId,
    started,
    threadModel: opened.model,
    executionLocation: opened.executionLocation,
    lost: opened.lost ?? null,
    handle: name === null ? null : threadHandle({ threadId, title: name }),
    model,
    sidebar,
    turn,
    now: clockReadableAt({ now, clock: turn }),
    working,
    mutations: mutations + delegatedToolCalls,
    contextTokens: used,
    pending: rows,
    handleSend,
    handleQueueSettled,
    handleTakeBackPending,
    handleRetry: retryable ? turnDriver.handleRetry : null,
    handleResume: resumable ? turnDriver.handleResume : null,
    readEvents,
    compacting,
    handleReportProblem: setFailure,
    handleInterrupt: turnDriver.handleInterrupt,
    handleNewConversation,
    handleOpenThread,
    handleRename: renameSession,
    handleCompact: compaction.compact,
    handleCompactAround: compaction.compactAround,
    handleRewindTo: turnDriver.handleRewindTo,
    handleRevokeGrant,
  }
}
