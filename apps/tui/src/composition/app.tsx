import { homedir } from 'node:os'

import type { KeyEvent, PasteEvent } from '@opentui/core'
import { usePaste, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react'
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import {
  contextPressure,
  ECompactionAnchor,
  launchWorktreeOf,
  type EExecutionLocation,
  type EUsageWindow,
  type ModelCard,
} from '@dltech/atlas-core'
import type { DiscoveredSkill } from '@dltech/atlas-harness'

import { newestExpandableKey } from '../store'
import { withContainer, withSections } from '../store/sidebar-model'
import { accountMeterSpans } from '../ui/account-meters'
import { accountOf, type AccountRow } from '../ui/accounts-model'
import { isWaiting, type BackgroundWork } from '../ui/background-wait'
import type { Span } from '../ui/components/spans'
import type { FooterMeter } from '../ui/usage-meters'
import { CommandMenu } from '../ui/components/command-menu'
import { FileMenu } from '../ui/components/file-menu'
import { Composer, composerRows, composerTone } from '../ui/components/composer'
import {
  readClipboardImage,
  readImageBase64,
  type ClipboardImageReader,
} from '../ui/clipboard-image'
import { restoredImages, submissionOf } from '../ui/draft-images'
import { isEmptyPaste, pastedContent } from '../ui/pasted-text'
import { useDraftTokens } from '../ui/hooks/use-draft-tokens'
import { liveTokens, tokenAtOffset, tokenizablePaste, type LiveToken } from '../ui/composer-tokens'
import { pasteDirectoryOf } from './paste-directory'
import { Footer, type FooterContext } from '../ui/components/footer'
import { footerLayout } from '../ui/footer-layout'
import { Screen } from '../ui/components/screen'
import { HeaderBar } from '../ui/components/header-bar'
import { useDiffStat } from '../ui/hooks/use-diff-stat'
import { useTerminalFocus } from '../ui/hooks/use-terminal-focus'
import { AgentTypes } from '../ui/components/agent-types'
import { LostChildren } from '../ui/components/lost-children'
import { hasLostChildren, lostChildrenNotice } from '../ui/lost-children-model'
import { Shortcuts } from '../ui/components/shortcuts'
import { Sidebar } from '../ui/components/sidebar'
import { NoticeStack } from '../ui/components/notice-stack'
import { WelcomeScreen } from '../ui/components/welcome-screen'
import { Transcript } from '../ui/components/transcript'
import { useDraft } from '../ui/hooks/use-draft'
import { useSince } from '../ui/hooks/use-since'
import { composerEdgeVersion, subscribeComposerEdge } from '../ui/composer-edge-store'
import { densityVersion, subscribeDensity } from '../ui/density-store'
import { modelLabel } from '../ui/model-label'
import { theme } from '../ui/theme'
import {
  clearNotice,
  configureNotices,
  ENoticePosition,
  ENoticeTone,
  NOTICE_KEY_CLASSIFIER_OFFLINE,
  NOTICE_KEY_LOST_AGENTS,
  NOTICE_WARN_MS,
  notify,
} from '../ui/notice-store'
import { paletteVersion, subscribePalette } from '../ui/palette-store'
import { ERewindPointKind, ERewindVerb, type RewindChoice } from '../ui/rewind-model'
import { SelectionSurface } from '../ui/selection/selection-surface'
import { useCopyOnSelect } from '../ui/selection/use-copy-on-select'
import {
  chromeWidthOf,
  contentWidthOf,
  ESidebarLayout,
  floatingSidebarWidth,
  peekInForce,
  sidebarLayout,
  sidebarShown,
} from '../ui/sidebar-visibility'
import { welcomeCells, welcoming } from '../ui/welcome-state'
import {
  createKeyRegistry,
  EKeyGroup,
  EKeyLayer,
  KeyRegistryContext,
  useKeyBindings,
  useKeyRegistry,
} from '../ui/keys'
import { commandSpecs, dispatchSubmission, EContainerAsk, EDispatch, localCommands } from './commands'
import { currentLocationNotice, movedLocationNotice } from './container-notices'
import { mcpReport } from './mcp-report'
import { useComposerMenus } from './use-composer-menus'
import { workspaceFileLoader } from './mentioned-files'
import { useResolvedMentions } from './use-resolved-mentions'
import type { AtlasApp } from './compose'
import { reloadedSkills, type SkillsReloaded } from './skills-reload'
import { globalBindings } from './global-bindings'
import { applyTranscriptCovered } from '../ui/covered-store'
import { OverlayStack } from './overlay-stack'
import { unmeasuredWindowWarning } from './providers'
import { settleStaleness } from './auto-restart'
import { checkForUpdate, sourceStalenessProbe, type SourceStaleness } from './update-check'
import type { OpenedConversation } from './open-conversation'
import { useConversation } from './use-conversation'
import { useExitGuard } from './use-exit-guard'
import {
  composerCovered,
  covering,
  keyOwners,
  transcriptCovered,
  type OverlayPresence,
} from './overlay-presence'
import { useOverlayKeys } from './use-overlay-keys'
import { useSettings } from './use-settings'
import { useServices } from './use-services'
import { useShells } from './use-shells'
import { subagentsSurface } from './agents-surface'
import { servicesSurface } from './services-surface'
import { shellsSurface } from './shells-surface'
import { usePluginSurfaces } from './use-plugin-surfaces'
import { useFooterStrip } from './use-footer-strip'
import { useRewind } from './use-rewind'
import { useAccounts } from './use-accounts'
import { useAgents } from './use-agents'
import { useAgentView } from './use-agent-view'
import { SubagentTranscript } from './subagent-transcript'
import { useAgentsPicker } from './use-agents-picker'
import { EModelScope, useSwitcher } from './use-switcher'
import { useThreadModel } from './use-thread-model'
import { useContainerPill } from './use-container-pill'
import { useExecutionLocation } from './use-execution-location'
import { useThreads } from './use-threads'
import { useUsageMeters } from './use-usage-meters'

const PLACEHOLDER = 'Ask anything'

const STEER_PLACEHOLDER = 'Steer the turn'

const SUBAGENT_PLACEHOLDER = 'Message this sub-agent'

const HELP_KEY = '?'

const STALE_CHECK_MS = 60_000

/**
 * Reference the operator reads and dismisses, drawn above the composer rather than over it. One at
 * a time, and any key puts it away, which is what makes it a veil rather than an overlay.
 */
enum EChromePanel {
  Shortcuts = 'shortcuts',
  AgentTypes = 'agent-types',
  LostAgents = 'lost-agents',
}

const composerPlaceholder = (args: { addressingChild: boolean; working: boolean }): string => {
  if (args.addressingChild) return SUBAGENT_PLACEHOLDER
  return args.working ? STEER_PLACEHOLDER : PLACEHOLDER
}

const readoutOf = (args: {
  card: ModelCard | undefined
  used: number
  meters: readonly FooterMeter[]
}): FooterContext | null => {
  const { card } = args

  if (card === undefined) return { percent: 0, measured: false, meters: args.meters }

  const pressure = contextPressure({ used: args.used, window: card.contextWindow })
  return { percent: pressure.percent, tokensUsed: pressure.used, meters: args.meters }
}

export function App(props: {
  app: AtlasApp
  opened: OpenedConversation
  credentialNotice?: string | null
  covered?: boolean
  clipboard?: ClipboardImageReader
  onRestart?: () => void
}): React.ReactNode {
  const registry = useMemo(() => createKeyRegistry(), [])

  return (
    <KeyRegistryContext.Provider value={registry}>
      <Workspace
        app={props.app}
        opened={props.opened}
        credentialNotice={props.credentialNotice ?? null}
        covered={props.covered === true}
        clipboard={props.clipboard ?? readClipboardImage}
        onRestart={props.onRestart ?? null}
      />
    </KeyRegistryContext.Provider>
  )
}

function Workspace(props: {
  app: AtlasApp
  opened: OpenedConversation
  credentialNotice: string | null
  covered: boolean
  clipboard: ClipboardImageReader
  onRestart: (() => void) | null
}): React.ReactNode {
  const renderer = useRenderer()
  const restarting = useRef(false)
  const exitGuard = useExitGuard({
    onExit: () => {
      if (restarting.current && props.onRestart !== null) {
        props.onRestart()
        return
      }
      renderer.destroy()
    },
  })
  const { width, height } = useTerminalDimensions()
  useSyncExternalStore(subscribePalette, paletteVersion)
  useSyncExternalStore(subscribeDensity, densityVersion)
  useSyncExternalStore(subscribeComposerEdge, composerEdgeVersion)
  const usageVersion = useSyncExternalStore(props.app.usage.subscribe, props.app.usage.version)

  const chooseDefaultModel = useRef<(() => void) | null>(null)
  const handleChooseDefaultModel = useCallback(() => chooseDefaultModel.current?.(), [])

  const settings = useSettings({ app: props.app, onChooseModel: handleChooseDefaultModel })

  useCopyOnSelect()

  const draft = useDraft()

  const handleFocusComposer = useCallback(() => draft.editor.current?.focus(), [draft])

  const conversation = useConversation({
    app: props.app,
    opened: props.opened,
    paceReveal: settings.paceReveal,
    autoCompactAtPercent: settings.autoCompactAtPercent,
    thinking: settings.thinking,
    tldrStatus: settings.tldrStatus,
    onUndone: draft.setValue,
    canWake: exitGuard.state === null,
  })

  const tokens = useDraftTokens({
    editor: draft.editor,
    read: props.clipboard,
    directory: pasteDirectoryOf(conversation.threadId),
  })

  const [peeking, setPeeking] = useState(false)
  const { sidebarWidth, sidebarFoldBelow } = settings
  const layout = sidebarLayout({ width, foldBelow: sidebarFoldBelow, sidebarWidth })
  const wide = layout === ESidebarLayout.Wide

  const tone = composerTone({
    working: conversation.working,
    interrupting: conversation.turn.interrupting,
  })

  const threadModel = useThreadModel({
    app: props.app,
    threadId: conversation.threadId,
    stored: conversation.threadModel,
    started: conversation.started,
  })

  const execution = useExecutionLocation({
    app: props.app,
    threadId: conversation.threadId,
    stored: conversation.executionLocation,
    started: conversation.started,
  })
  const containerPill = useContainerPill({ app: props.app })

  const { selection } = threadModel

  const [panel, setPanel] = useState<EChromePanel | null>(null)
  const [sends, setSends] = useState(0)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [loadedSkills, setLoadedSkills] = useState<readonly DiscoveredSkill[]>(() =>
    props.app.skillRegistry.all(),
  )

  const card = props.app.models.cardFor(selection.ref)

  const metered = props.app.models.subscribed(selection.ref.providerId)

  const meters = useUsageMeters({
    usage: props.app.usage,
    metered,
    show: settings.footerMeters,
    warn: settings.usageWarn,
  })

  const { contextTokens } = conversation
  const readout = useMemo(
    () => readoutOf({ card, used: contextTokens, meters }),
    [card, contextTokens, meters],
  )

  useEffect(() => {
    const warning = unmeasuredWindowWarning({
      catalogue: props.app.models,
      ref: props.app.model.choice().ref,
    })
    if (warning === null) return

    notify({
      key: 'context-window-unmeasured',
      text: warning,
      tone: ENoticeTone.Warn,
      ttlMs: NOTICE_WARN_MS,
    })
  }, [props.app.model, props.app.models])

  /**
   * Ambient and off the boot path: a stale-build or release-available notice may arrive a beat
   * after the curtain lifts, and a probe that cannot reach its ground truth says nothing. The
   * staleness probe stamps the source tree at launch; the slow timer and the turn-end edge below
   * are what act on it.
   */
  const staleness = useRef<SourceStaleness | null>(null)
  useEffect(() => {
    void checkForUpdate()

    let mounted = true
    void sourceStalenessProbe().then((probe) => {
      if (mounted) staleness.current = probe
    })

    return () => {
      mounted = false
    }
  }, [])

  const { usage } = props.app
  const working = conversation.working

  useEffect(() => {
    if (working) {
      usage.track()
      return
    }
    usage.stopTracking()
  }, [usage, working])

  const handleNewConversation = useCallback(() => {
    draft.clear()
    conversation.handleNewConversation()
  }, [conversation, draft])

  const switcher = useSwitcher({
    catalogue: props.app.models,
    active: selection.ref,
    effort: selection.effort,
    fallback: threadModel.fallback,
    favourites: settings.modelFavourites,
    onPick: threadModel.handlePicked,
    onPin: settings.handlePinModels,
  })

  const openSwitcher = switcher.handleOpen

  useEffect(() => {
    chooseDefaultModel.current = () => openSwitcher(EModelScope.Default)
  }, [openSwitcher])

  const shells = useShells({ app: props.app, threadId: conversation.threadId })
  const services = useServices({ app: props.app })

  const { lost } = conversation

  const handleShowLostAgents = useCallback((): boolean => {
    if (!hasLostChildren(lost)) return false

    clearNotice({ key: NOTICE_KEY_LOST_AGENTS })
    setPanel(EChromePanel.LostAgents)
    return true
  }, [lost])

  /**
   * Announced rather than raised: nothing else in the conversation will ever mention a child with
   * no `agent-spawned` behind it, so a sticky notice stands until the card it points at is opened.
   * The card itself stays asked for — a conversation reopened only to be read is not interrupted.
   */
  useEffect(() => {
    if (!hasLostChildren(lost)) {
      clearNotice({ key: NOTICE_KEY_LOST_AGENTS })
      return
    }

    notify({
      key: NOTICE_KEY_LOST_AGENTS,
      text: lostChildrenNotice(lost),
      tone: ENoticeTone.Warn,
      sticky: true,
    })
  }, [lost])

  const judgeUnreachable = conversation.sidebar.classifier?.judgeUnreachable === true

  useEffect(() => {
    if (!judgeUnreachable) {
      clearNotice({ key: NOTICE_KEY_CLASSIFIER_OFFLINE })
      return
    }

    notify({
      key: NOTICE_KEY_CLASSIFIER_OFFLINE,
      text: 'nudge offline — the classifier could not be reached',
      tone: ENoticeTone.Warn,
      sticky: true,
    })
  }, [judgeUnreachable])

  useEffect(() => {
    configureNotices({ ttlMs: settings.noticeSeconds * 1000 })
  }, [settings.noticeSeconds])

  const handleOpenThread = useCallback(
    (threadId: string) => {
      draft.clear()
      conversation.handleOpenThread(threadId)
    },
    [conversation, draft],
  )

  const agentView = useAgentView({
    app: props.app,
    threadId: conversation.threadId,
    onFocusComposer: handleFocusComposer,
    onProblem: conversation.handleReportProblem,
  })

  const agents = useAgents({
    app: props.app,
    threadId: conversation.threadId,
    sidebar: conversation.sidebar,
    viewing: agentView.viewing,
  })

  const agentsPicker = useAgentsPicker({
    app: props.app,
    threadId: conversation.threadId,
    onPick: agentView.handleSelect,
  })

  /**
   * What the settled turn is still waiting on, and since when.
   *
   * Measured here rather than in the line that draws it, because the transcript unmounts whenever a
   * sub-agent is opened: a reading taken at the render site would restart every time the operator
   * looked at a child and came back. Nothing about the wait is a fact about which thread is on
   * screen, so nothing about it belongs below this point.
   */
  const background = useMemo(
    (): BackgroundWork => ({ agents: agents.running, shells: shells.running }),
    [agents.running, shells.running],
  )
  const waitingSince = useSince(isWaiting(background))

  /**
   * Nothing said yet is a state of its own, not an empty transcript: the wordmark and the composer
   * sit centred with the whole terminal to themselves, and the sidebar stays away until there is a
   * conversation for it to read.
   */
  const welcome = welcoming({
    model: conversation.model,
    addressingChild: agentView.viewing !== null,
  })
  const sidebarVisible = !welcome && sidebarShown({ layout, peeking })
  const overlay = sidebarVisible && !wide

  const repoRoot = props.app.workspace.repo ?? props.app.config.cwd
  const sidebarWorktree =
    conversation.activeWorktree?.path ??
    (conversation.projectDirectory.startsWith(`${repoRoot}/`)
      ? conversation.projectDirectory
      : null)
  const projectRoot = sidebarWorktree === null ? conversation.projectDirectory : repoRoot
  const headerDiff = useDiffStat({
    projectDirectory: conversation.projectDirectory,
    working: conversation.working,
    focus: useTerminalFocus(),
    mutations: conversation.mutations,
  })
  const docked = wide && !welcome
  const contentWidth = contentWidthOf({ width, sidebarWidth, docked })
  const chromeWidth = chromeWidthOf({ width, sidebarWidth, docked })
  const composerWidth = welcome ? welcomeCells({ width: chromeWidth }) : chromeWidth

  const threads = useThreads({
    app: props.app,
    activeThreadId: conversation.threadId,
    onPick: handleOpenThread,
  })

  /**
   * `/resume` with a handle goes straight there, the way `atlas --resume` does; bare, it opens the
   * picker. One command, because naming a conversation and choosing one are the same intent.
   */
  const handleResumeConversation = useCallback(
    (handle: string) => {
      if (handle === '') {
        threads.handleOpen()
        return
      }

      handleOpenThread(handle)
    },
    [handleOpenThread, threads],
  )

  const accounts = useAccounts({
    accounts: props.app.accounts,
    openUrl: props.app.openUrl,
    onAccounts: props.app.models.observeAccounts,
  })
  const accountsOpen = accounts.state !== null
  const accountRows = accounts.state?.rows

  useEffect(() => {
    if (!accountsOpen) return
    for (const row of accountRows ?? []) {
      const account = accountOf(row)
      if (account !== undefined) void usage.refresh({ accountId: account.id })
    }
  }, [accountRows, accountsOpen, usage])

  const accountMeters = useMemo(
    () =>
      (row: AccountRow): readonly Span[] => {
        const account = accountOf(row)
        if (account === undefined) return []

        return accountMeterSpans({
          usage: usage.snapshotFor({ accountId: account.id }),
          warn: settings.usageWarn,
          now: Date.now(),
        })
      },
    [settings.usageWarn, usage, usageVersion],
  )

  /**
   * A boot-time auth failure is usually ambient (DNS down, a revoked refresh token), so it earns a
   * chip rather than the screen. The full diagnosis waits for the first manual open of the overlay,
   * which is what the chip points at.
   */
  const { credentialNotice } = props
  const notified = useRef(false)
  const pendingCredentialNotice = useRef<string | null>(null)
  useEffect(() => {
    if (credentialNotice === null || notified.current) return

    notified.current = true
    pendingCredentialNotice.current = credentialNotice
    notify({
      key: 'credential-failure',
      text: 'A provider login is failing — press ctrl+a or run /auth.',
      tone: ENoticeTone.Warn,
      ttlMs: 23_000,
    })
  }, [credentialNotice])

  const handleOpenAccounts = useCallback(() => {
    const notice = pendingCredentialNotice.current
    pendingCredentialNotice.current = null
    accounts.handleOpen(notice ?? undefined)
  }, [accounts])

  const handleRewindChoice = useCallback(
    ({ point, verb }: RewindChoice) => {
      if (verb === ERewindVerb.ToHere) {
        conversation.handleRewindTo(point.seq - 1)
        if (point.kind === ERewindPointKind.Said) draft.setValue(point.text)
        return
      }

      if (verb === ERewindVerb.SummariseUpTo) {
        conversation.handleCompactAround({ anchor: ECompactionAnchor.Prefix, seq: point.seq - 1 })
        return
      }

      conversation.handleCompactAround({ anchor: ECompactionAnchor.Suffix, seq: point.seq })
    },
    [conversation, draft],
  )

  const rewind = useRewind({ events: conversation.readEvents, onPick: handleRewindChoice })

  const handleToggle = useCallback((key: string) => {
    setOpened((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  /**
   * What the transcript's `⏎ open` rows promise. Nothing carries focus in the transcript, so the
   * key acts on the newest thing that can be unfolded, and only when the draft is empty.
   */
  const handleOpenNewest = useCallback((): boolean => {
    const key = newestExpandableKey(conversation.model.entries)
    if (key === null) return false

    handleToggle(key)
    return true
  }, [conversation.model.entries, handleToggle])

  const handleReloadSkills = useCallback(async (): Promise<SkillsReloaded> => {
    const before = props.app.skillRegistry.all()
    const after = await props.app.skillRegistry.reload()
    setLoadedSkills(after)
    return reloadedSkills({ before, after })
  }, [props.app.skillRegistry])

  const handleRestart = useCallback(() => {
    if (props.onRestart === null) return

    if (shells.running + agents.running + services.running > 0) {
      restarting.current = true
      exitGuard.handleOpen()
      return
    }

    props.onRestart()
  }, [agents.running, exitGuard, props.onRestart, services.running, shells.running])

  useEffect(() => {
    if (exitGuard.state === null) restarting.current = false
  }, [exitGuard.state])

  /**
   * The falling edge of `working` is a turn ending; the slow timer covers the idle stretches —
   * the welcome screen above all, where no turn ever ends. Both are moments a stale atlas-dev
   * session may swap itself out without taking anything with it. The safety snapshot is read
   * after the stamp check resolves rather than captured up front, so a keystroke that lands in
   * between still holds the restart off. Anything less than clean falls back to the sticky notice.
   */
  const settleStale = useCallback(
    () =>
      void settleStaleness({
        staleness: staleness.current,
        autoRestart: settings.autoRestart,
        restart: props.onRestart,
        readSafety: () => ({
          working: conversation.working,
          interrupting: conversation.turn.interrupting,
          compacting: conversation.compacting !== null,
          approvalOpen: conversation.approval.state !== null,
          exitGuardOpen: exitGuard.state !== null,
          queuedMessages: props.app.pending.waitingCount(),
          runningTasks: shells.running + agents.running + services.running,
          draftEmpty: (draft.editor.current?.plainText ?? draft.value).length === 0,
        }),
      }),
    [
      settings.autoRestart,
      props.onRestart,
      props.app.pending,
      conversation,
      exitGuard.state,
      shells.running,
      agents.running,
      services.running,
      draft,
    ],
  )

  const settleStaleRef = useRef(settleStale)
  useEffect(() => {
    settleStaleRef.current = settleStale
  })

  const wasWorking = useRef(false)
  useEffect(() => {
    const turnEnded = wasWorking.current && !working
    wasWorking.current = working
    if (!turnEnded) return

    settleStale()
  }, [working, settleStale])

  useEffect(() => {
    const timer = setInterval(() => settleStaleRef.current(), STALE_CHECK_MS)
    return () => clearInterval(timer)
  }, [])

  // OpenTUI parses a whole input burst before React re-renders, so a paste — or ⏎ arriving in the
  // same burst as the text — reaches here with `draft.value` still empty. The buffer is the truth.
  const handleContainer = useCallback(
    (asked: EExecutionLocation | EContainerAsk): string => {
      if (asked === EContainerAsk.Current) return currentLocationNotice(execution.location)

      execution.handleSet(asked)
      return movedLocationNotice(asked)
    },
    [execution],
  )

  const commands = useMemo(
    () =>
      localCommands({
        onContainer: handleContainer,
        onCompact: conversation.handleCompact,
        onRewind: rewind.handleOpen,
        onShortcuts: () => setPanel(EChromePanel.Shortcuts),
        onOpenSwitcher: () => openSwitcher(),
        onOpenShells: () => shells.handleOpen(),
        onOpenAgents: agentsPicker.handleOpen,
        onShowAgentTypes: () => setPanel(EChromePanel.AgentTypes),
        onShowLostAgents: handleShowLostAgents,
        onOpenSettings: settings.handleOpen,
        onOpenAccounts: handleOpenAccounts,
        onNewConversation: handleNewConversation,
        onOpenThreads: handleResumeConversation,
        onRename: conversation.handleRename,
        onReloadSkills: handleReloadSkills,
        onShowMcp: () => mcpReport({ servers: props.app.mcp() }),
        onRestart: props.onRestart === null ? null : handleRestart,
      }),
    [
      agentsPicker.handleOpen,
      conversation.handleCompact,
      conversation.handleRename,
      handleContainer,
      handleNewConversation,
      handleOpenAccounts,
      handleReloadSkills,
      handleRestart,
      props.app,
      props.onRestart,
      rewind.handleOpen,
      settings.handleOpen,
      shells,
      switcher.handleOpen,
      handleResumeConversation,
    ],
  )

  const skills = useMemo(() => loadedSkills.filter((skill) => skill.userInvocable), [loadedSkills])

  const specs = useMemo(() => commandSpecs({ commands, skills }), [commands, skills])

  const menus = useComposerMenus({ specs, files: props.app.files, onComplete: draft.setValue })
  const readDraft = useRef(menus.handleTextChanged)
  readDraft.current = menus.handleTextChanged

  useEffect(() => {
    readDraft.current(draft.value)
  }, [draft.value])

  const mentionSpans = useResolvedMentions({ text: draft.value, files: props.app.files })

  /**
   * The label goes in at the cursor and the buffer is read straight back, because OpenTUI's editor
   * owns the text and only mirrors it into React on its own change event.
   */
  /**
   * The token is written as a `virtual` extmark carrying its slot, which is what makes it one thing
   * to the cursor rather than a string of characters: OpenTUI's `ExtmarksController` wraps the
   * buffer's own motion and deletion — left, right, visual up and down, backspace, delete, selection
   * delete, undo and redo — so every one of them steps over the span whole instead of into it.
   */
  const cursorOffsetBefore = useRef<number | null>(null)

  const handleCursorMoved = useCallback(() => {
    const editor = draft.editor.current
    if (editor === null) return

    const offset = editor.cursorOffset
    const before = cursorOffsetBefore.current
    cursorOffsetBefore.current = offset

    const token = tokenAtOffset({ editor, offset })
    if (token === null) return

    const steppingLeft = before !== null && offset < before
    const boundary = steppingLeft ? token.start : token.end
    if (boundary === offset) return

    cursorOffsetBefore.current = boundary

    const selection = editor.getSelection()
    if (selection !== null) {
      editor.setSelection(selection.start === selection.end ? boundary : selection.start, boundary)
      return
    }

    editor.cursorOffset = boundary
  }, [draft])

  const handleAttachImage = useCallback((): boolean => {
    tokens.handleImage()
    return true
  }, [tokens])

  const [tokenSpans, setTokenSpans] = useState<readonly LiveToken[]>([])

  useEffect(() => {
    const editor = draft.editor.current
    if (editor === null) return
    setTokenSpans(liveTokens(editor))
  }, [draft])

  const highlights = useMemo(
    () => [...mentionSpans, ...tokenSpans],
    [mentionSpans, tokenSpans],
  )

  const highlightedFiles = useMemo(
    () => new Set(mentionSpans.map((mention) => mention.path)),
    [mentionSpans],
  )

  const handleSubmit = useCallback(() => {
    void (async () => {
      const editor = draft.editor.current
      const said = editor?.plainText ?? draft.value

      await tokens.settle()
      const live = editor === null ? [] : tokens.tokens()
      const readyImages = live.flatMap((token) =>
        token.slot.kind === 'image' && token.slot.image !== null
          ? [{ ...token.slot.image, ordinal: token.slot.ordinal }]
          : [],
      )

      if (said.trim().length === 0 && live.length === 0) {
        handleOpenNewest()
        return
      }

      draft.clear()
      setSends((count) => count + 1)

      const putBack = () => {
        draft.setValue(said)
        tokens.restore(readyImages)
      }

      if (agentView.viewing !== null) {
        const spoken = submissionOf({ text: said, tokens: live, load: readImageBase64 })
        void agentView.handleSay(spoken).then((refusal) => {
          if (refusal === null) return

          putBack()
          conversation.handleReportProblem(refusal)
        })
        return
      }

      void dispatchSubmission({
        text: said,
        commands,
        skills,
        working: conversation.working,
        highlightedFiles,
        ...(props.app.files === undefined
          ? {}
          : { loadFile: workspaceFileLoader(props.app.files) }),
      }).then((dispatched) => {
        if (dispatched.type === EDispatch.Queued) {
          tokens.restore(readyImages)
          conversation.handleQueueSettled(dispatched.entry)
          return
        }
        if (dispatched.type === EDispatch.Refused) {
          putBack()
          conversation.handleReportProblem(dispatched.reason)
          return
        }
        if (dispatched.type === EDispatch.Ran) {
          tokens.restore(readyImages)
          if (dispatched.notice !== undefined) notify({ text: dispatched.notice })
          return
        }
        if (dispatched.type !== EDispatch.Send) return

        const sending = submissionOf({
          text: dispatched.text,
          tokens: live,
          load: readImageBase64,
        })
        conversation.handleSend({ ...sending, context: dispatched.drafts })
      })
    })()
  }, [
    agentView,
    commands,
    conversation,
    draft,
    handleOpenNewest,
    highlightedFiles,
    props.app.files,
    skills,
    tokens,
  ])

  const surfaces = usePluginSurfaces({
    surfaces: [
      ...props.app.pluginSurfaces,
      shellsSurface({ shells }),
      servicesSurface({ services }),
      subagentsSurface({ agents, picker: agentsPicker }),
    ],
  })

  /**
   * The ladder inside `footerLayout` is what decides which pills survive the width, so the row is
   * laid out once here and both readers are given the same answer. Handing the strip the full list
   * would let a selection outlive the pill it names when the terminal is dragged narrower.
   */
  const footerRow = useMemo(
    () =>
      footerLayout({
        width: chromeWidth,
        model: card?.label ?? modelLabel(selection.ref.modelId),
        effort: selection.effort,
        items: surfaces.footerItems,
        context: readout,
      }),
    [card, chromeWidth, readout, selection.effort, selection.ref, surfaces.footerItems],
  )

  const footerStrip = useFooterStrip({ items: footerRow.instruments.items, draft })

  /**
   * The draft is asked for its buffer rather than its mirror because OpenTUI parses a whole input
   * burst before React re-renders, so a `?` pasted after text would otherwise read as empty.
   */
  const draftIsEmpty = useCallback(
    (): boolean => (draft.editor.current?.plainText ?? draft.value).length === 0,
    [draft],
  )

  const handleTakeBackPending = useCallback((): boolean => {
    const taking = conversation.handleTakeBackPending()
    if (taking === null) return false

    void taking.then((taken) => {
      if (taken === null) return

      /**
       * A draft taken back out of the queue arrives as plain text, so its tokens come back without
       * the extmarks that made them whole. They are re-marked from the images it carried, or a
       * picture that survived a take-back would be the one the cursor could still walk into.
       */
      draft.setValue(taken.text)
      tokens.restore(restoredImages({ images: taken.images, text: taken.text }))
    })
    return true
  }, [conversation, draft, tokens])

  const handleToggleSidebar = useCallback(() => setPeeking((open) => !open), [])

  const handleClosePeek = useCallback(() => setPeeking(false), [])

  useEffect(() => {
    setPeeking((open) => peekInForce({ layout, peeking: open }))
  }, [layout])

  const handleQuit = useCallback(() => {
    if (conversation.working) {
      conversation.handleInterrupt()
      return
    }

    if (shells.running + agents.running + services.running > 0) {
      exitGuard.handleOpen()
      return
    }

    renderer.destroy()
  }, [agents.running, conversation, exitGuard, renderer, services.running, shells])

  useEffect(() => {
    if (exitGuard.state !== null && shells.running + agents.running + services.running === 0) {
      exitGuard.handleDismiss()
    }
  }, [agents.running, exitGuard, services.running, shells.running])

  useKeyBindings(
    globalBindings({
      draftIsEmpty,
      onSubmit: handleSubmit,
      onShortcuts: () => setPanel(EChromePanel.Shortcuts),
      onTakeBackPending: handleTakeBackPending,
      onEnterFooterStrip: footerStrip.handleEnter,
      onInterrupt: conversation.handleInterrupt,
      onOpenSwitcher: () => openSwitcher(),
      onNewConversation: handleNewConversation,
      onAttachImage: handleAttachImage,
      onOpenShells: () => shells.handleOpen(),
      onCycleAgents: agents.count === 0 ? null : agentView.handleCycle,
      onToggleSidebar: wide ? null : handleToggleSidebar,
      onOpenSettings: settings.handleOpen,
      onOpenAccounts: handleOpenAccounts,
      onQuit: handleQuit,
    }),
  )

  /**
   * Escape closes the floating sidebar rather than interrupting the turn, and it wins by sitting a
   * layer above the global chord instead of by owning the keyboard — everything else the app binds
   * has to keep working while the sidebar is up.
   */
  useKeyBindings(
    overlay
      ? [
          {
            chord: 'escape',
            hint: 'close sidebar',
            layer: EKeyLayer.Block,
            group: EKeyGroup.Session,
            run: handleClosePeek,
          },
        ]
      : [],
  )

  const registry = useKeyRegistry()

  const { approval } = conversation
  const compacting = conversation.compacting !== null

  const overlays = useMemo(
    (): readonly OverlayPresence[] => [
      covering(exitGuard.state !== null, exitGuard.handleKey),
      covering(approval.state !== null, approval.handleKey),
      covering(rewind.state !== null, rewind.handleKey),
      covering(switcher.state !== null, switcher.handleKey),
      covering(shells.state !== null, shells.handleKey),
      covering(services.state !== null, services.handleKey),
      covering(accounts.state !== null, accounts.handleKey),
      covering(threads.state !== null, threads.handleKey),
      covering(agentsPicker.state !== null, agentsPicker.handleKey),
      { ...covering(settings.state !== null, settings.handleKey), porous: true },
      { ...covering(footerStrip.state !== null, footerStrip.handleKey), coversTranscript: false },
      { open: compacting, coversComposer: true, coversTranscript: true },
      { open: overlay, coversComposer: true, coversTranscript: false },
    ],
    [
      accounts.handleKey,
      accounts.state,
      agentsPicker.handleKey,
      agentsPicker.state,
      approval.handleKey,
      approval.state,
      compacting,
      exitGuard.handleKey,
      exitGuard.state,
      footerStrip.handleKey,
      footerStrip.state,
      overlay,
      rewind.handleKey,
      rewind.state,
      services.handleKey,
      services.state,
      settings.handleKey,
      settings.state,
      shells.handleKey,
      shells.state,
      switcher.handleKey,
      switcher.state,
      threads.handleKey,
      threads.state,
    ],
  )

  const owners = useMemo(() => keyOwners(overlays), [overlays])
  const handleDismissPanel = useCallback(() => setPanel(null), [])
  const veil = useMemo(
    () => ({ shown: panel !== null, dismiss: handleDismissPanel, keys: [HELP_KEY] }),
    [handleDismissPanel, panel],
  )

  const handleKey = useOverlayKeys({ veil, owners, bindings: registry.snapshot })

  const handleKeyWithMenu = useCallback(
    (key: KeyEvent) => {
      if (props.covered) return

      if (menus.handleKey(key)) {
        key.preventDefault()
        return
      }

      handleKey(key)
    },
    [handleKey, menus, props.covered],
  )

  useKeyboard(handleKeyWithMenu)

  const overlaid = props.covered || composerCovered(overlays)

  const picturesCovered = props.covered || transcriptCovered(overlays)

  useEffect(() => {
    applyTranscriptCovered(picturesCovered)
  }, [picturesCovered])

  /**
   * What the terminal's own paste carries decides the token: nothing means a picture is waiting on
   * the clipboard, and beyond a few lines the clipboard becomes a `[Pasted text]` token so a
   * thousand-row dump does not spray the composer. A real image read resolves the empty paste; the
   * long text folds in right away.
   */
  usePaste(
    useCallback(
      (event: PasteEvent) => {
        if (overlaid) return

        const content = pastedContent(event)
        if (isEmptyPaste(event)) {
          event.preventDefault()
          event.stopPropagation()
          handleAttachImage()
          return
        }

        if (tokenizablePaste(content)) {
          event.preventDefault()
          event.stopPropagation()
          tokens.handlePasted(content)
          return
        }
      },
      [handleAttachImage, overlaid, tokens],
    ),
  )

  const sidebarModel = useMemo(
    () =>
      withSections({
        model: withContainer({ model: agents.sidebar, container: containerPill }),
        sections: surfaces.sidebarSections,
      }),
    [agents.sidebar, containerPill, surfaces.sidebarSections],
  )

  const placeholder = composerPlaceholder({
    addressingChild: agentView.viewing !== null,
    working: conversation.working,
  })

  return (
    <Screen>
      <SelectionSurface>
        <box flexDirection="column" width={contentWidth} flexGrow={1} flexShrink={1} flexBasis={0}>
          {welcome ? null : (
            <HeaderBar
              width={chromeWidth}
              projectDirectory={conversation.projectDirectory}
              repoRoot={repoRoot}
              diff={headerDiff}
            />
          )}
          <box flexDirection="column" flexGrow={1} flexShrink={1}>
            <box flexGrow={welcome ? 1 : 0} flexShrink={1} />
            {welcome ? (
              <WelcomeScreen
                cwd={props.app.config.cwd}
                home={homedir()}
                modelId={selection.ref.modelId}
                width={contentWidth}
              />
            ) : agentView.selected === null ? (
              <Transcript
                model={conversation.model}
                width={contentWidth}
                now={conversation.now}
                cwd={conversation.projectDirectory}
                turn={conversation.turn}
                sends={sends}
                pending={conversation.pending}
                background={background}
                waitingSince={waitingSince}
                {...(conversation.handleRetry === null
                  ? {}
                  : { onRetry: conversation.handleRetry })}
                {...(conversation.handleResume === null
                  ? {}
                  : { onResume: conversation.handleResume })}
                opened={opened}
                onToggle={handleToggle}
              />
            ) : (
              <SubagentTranscript
                app={props.app}
                agent={agentView.selected}
                thinking={settings.thinking}
                width={contentWidth}
                cwd={conversation.projectDirectory}
                opened={opened}
                onToggle={handleToggle}
              />
            )}
          </box>
          {settings.noticePosition === ENoticePosition.Composer ? null : (
            <NoticeStack width={chromeWidth} />
          )}
          {panel === EChromePanel.Shortcuts ? <Shortcuts width={chromeWidth} /> : null}
          {panel === EChromePanel.AgentTypes ? (
            <AgentTypes width={chromeWidth} catalog={props.app.agentTypes} />
          ) : null}
          {panel === EChromePanel.LostAgents ? (
            <LostChildren width={chromeWidth} lost={conversation.lost} />
          ) : null}
          <box
            flexDirection="column"
            flexShrink={0}
            width={composerWidth}
            alignSelf={welcome ? 'center' : 'flex-start'}
          >
            {menus.command === null ? null : (
              <CommandMenu state={menus.command} width={composerWidth} />
            )}
            {menus.file === null ? null : <FileMenu state={menus.file} width={composerWidth} />}
            <Composer
              draft={draft}
              width={composerWidth}
              tone={tone}
              placeholder={placeholder}
              maxRows={composerRows(height)}
              focused={!overlaid}
              highlights={highlights}
              onCursorMoved={handleCursorMoved}
              {...(settings.noticePosition === ENoticePosition.Composer
                ? { notices: true }
                : {})}
              {...(agentView.name === null
                ? conversation.handle === null
                  ? {}
                  : { title: conversation.handle }
                : { title: `@${agentView.name}`, accent: theme.court.external })}
            />
          </box>
          <box flexGrow={welcome ? 1 : 0} flexShrink={1} />
          <Footer
            width={chromeWidth}
            model={card?.label ?? modelLabel(selection.ref.modelId)}
            layout={footerRow}
            strip={footerStrip.state}
            onActivateItem={footerStrip.handleActivate}
            {...(readout === null ? {} : { context: readout })}
          />
        </box>
        {sidebarVisible ? (
          <Sidebar
            width={overlay ? floatingSidebarWidth({ width, sidebarWidth }) : sidebarWidth}
            model={sidebarModel}
            root={projectRoot}
            worktree={sidebarWorktree}
            overlay={overlay}
            shells={shells.folded}
            shellNow={shells.now}
            shellFold={shells.fold}
            services={services.folded}
            serviceNow={services.now}
            serviceFold={services.fold}
            onOpenShell={shells.handleOpen}
            onOpenService={services.handleOpen}
            onSelectSubagent={agentView.handleSelect}
            onRevokeGrant={conversation.handleRevokeGrant}
          />
        ) : null}
        <OverlayStack
          width={width}
          contentWidth={contentWidth}
          cwd={props.app.config.cwd}
          active={selection.ref}
          accountMeters={accountMeters}
          switcher={switcher}
          shells={shells}
          services={services}
          agents={agents}
          settings={settings}
          accounts={accounts}
          threads={threads}
          agentsPicker={agentsPicker}
          rewind={rewind}
          approval={conversation.approval}
          exitGuard={exitGuard}
          compacting={conversation.compacting}
          now={conversation.now}
        />
      </SelectionSurface>
    </Screen>
  )
}
