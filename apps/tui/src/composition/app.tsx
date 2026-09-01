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
  imageTag,
  imageTagAround,
  imageTagSpans,
  nearerEdgeOf,
  modelEntry,
  type EUsageWindow,
  type ModelEntry,
} from '@dltech/atlas-core'
import type { DiscoveredSkill } from '@dltech/atlas-harness'

import { newestExpandableKey } from '../store'
import { accountMeterSpans } from '../ui/account-meters'
import type { AccountRow } from '../ui/accounts-model'
import type { Span } from '../ui/components/spans'
import { usageMeters, type FooterMeter } from '../ui/usage-meters'
import { CommandMenu } from '../ui/components/command-menu'
import { FileMenu } from '../ui/components/file-menu'
import { Composer, composerRows, composerTone } from '../ui/components/composer'
import { readClipboardImage, readImageBase64, type ClipboardImageReader } from '../ui/clipboard-image'
import { restoredImages, submissionOf } from '../ui/draft-images'
import { isEmptyPaste } from '../ui/pasted-text'
import { useDraftImages } from '../ui/hooks/use-draft-images'
import { pasteDirectoryOf } from './paste-directory'
import { Footer, type FooterContext } from '../ui/components/footer'
import { Screen } from '../ui/components/screen'
import { AgentTypes } from '../ui/components/agent-types'
import { LostChildren } from '../ui/components/lost-children'
import { hasLostChildren } from '../ui/lost-children-model'
import { Shortcuts } from '../ui/components/shortcuts'
import { Sidebar } from '../ui/components/sidebar'
import { WelcomeScreen } from '../ui/components/welcome-screen'
import { Transcript } from '../ui/components/transcript'
import { useDraft } from '../ui/hooks/use-draft'
import { composerEdgeVersion, subscribeComposerEdge } from '../ui/composer-edge-store'
import { densityVersion, subscribeDensity } from '../ui/density-store'
import { modelLabel } from '../ui/model-label'
import { theme } from '../ui/theme'
import { notify } from '../ui/notice-store'
import { paletteVersion, subscribePalette } from '../ui/palette-store'
import { ERewindPointKind, ERewindVerb, type RewindChoice } from '../ui/rewind-model'
import { SelectionSurface } from '../ui/selection/selection-surface'
import { useCopyOnSelect } from '../ui/selection/use-copy-on-select'
import type { SwitcherChoice } from '../ui/switcher-model'
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
import { commandSpecs, dispatchSubmission, EDispatch, localCommands } from './commands'
import { useComposerMenus } from './use-composer-menus'
import { workspaceFileLoader } from './mentioned-files'
import { useResolvedMentions } from './use-resolved-mentions'
import type { AtlasApp } from './compose'
import { reloadedSkills, type SkillsReloaded } from './skills-reload'
import { globalBindings } from './global-bindings'
import { applyTranscriptCovered } from '../ui/covered-store'
import { OverlayStack } from './overlay-stack'
import type { ModelSelection } from './model-selection'
import type { OpenedConversation } from './open-conversation'
import { useConversation } from './use-conversation'
import { useExitGuard } from './use-exit-guard'
import { useOverlayKeys } from './use-overlay-keys'
import { useSettings } from './use-settings'
import { useShells } from './use-shells'
import { useRewind } from './use-rewind'
import { useAccounts } from './use-accounts'
import { useAgents } from './use-agents'
import { useAgentView } from './use-agent-view'
import { useAgentsPicker } from './use-agents-picker'
import { useSwitcher } from './use-switcher'
import { useThreads } from './use-threads'

const PLACEHOLDER = 'Ask anything'

const STEER_PLACEHOLDER = 'Steer the turn'

const SUBAGENT_PLACEHOLDER = 'Message this sub-agent'

const HELP_KEY = '?'

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
  entry: ModelEntry | undefined
  used: number
  meters: readonly FooterMeter[]
}): FooterContext | null => {
  const { entry } = args
  if (entry === undefined) return null

  const pressure = contextPressure({ used: args.used, window: entry.contextWindow })
  return { percent: pressure.percent, tokensUsed: pressure.used, meters: args.meters }
}

export function App(props: {
  app: AtlasApp
  opened: OpenedConversation
  credentialNotice?: string | null
  covered?: boolean
  clipboard?: ClipboardImageReader
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
}): React.ReactNode {
  const renderer = useRenderer()
  const exitGuard = useExitGuard({ onExit: () => renderer.destroy() })
  const { width, height } = useTerminalDimensions()
  useSyncExternalStore(subscribePalette, paletteVersion)
  useSyncExternalStore(subscribeDensity, densityVersion)
  useSyncExternalStore(subscribeComposerEdge, composerEdgeVersion)
  useSyncExternalStore(props.app.usage.subscribe, props.app.usage.version)

  const settings = useSettings({ app: props.app })

  useCopyOnSelect()

  const draft = useDraft()

  const handleFocusComposer = useCallback(() => draft.editor.current?.focus(), [draft])

  const conversation = useConversation({
    app: props.app,
    opened: props.opened,
    paceReveal: settings.paceReveal,
    autoCompactAtPercent: settings.autoCompactAtPercent,
    thinking: settings.thinking,
    onUndone: draft.setValue,
    canWake: exitGuard.state === null,
  })

  const attachments = useDraftImages({
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

  const [selection, setSelection] = useState<ModelSelection>(() => props.app.model.choice())
  const [panel, setPanel] = useState<EChromePanel | null>(null)
  const [sends, setSends] = useState(0)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [loadedSkills, setLoadedSkills] = useState<readonly DiscoveredSkill[]>(() =>
    props.app.skillRegistry.all(),
  )

  /**
   * A configured model id carries its release stamp; the catalog is keyed without one, so every
   * reading of "what is answering" goes through the entry rather than the raw id.
   */
  const entry = modelEntry(selection.modelId)
  const activeModelId = entry?.id ?? selection.modelId

  const meters = usageMeters({
    usage: props.app.usage.snapshot(),
    show: settings.footerMeters,
    warn: settings.usageWarn,
    now: Date.now(),
  })

  const readout = readoutOf({ entry, used: conversation.contextTokens, meters })

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

  const handlePicked = useCallback(
    (choice: SwitcherChoice) => {
      if (choice.modelId === null) return

      props.app.model.select({ modelId: choice.modelId, effort: choice.effort })
      setSelection(props.app.model.choice())
    },
    [props.app.model],
  )

  const switcher = useSwitcher({
    activeModelId,
    effort: selection.effort,
    onPick: handlePicked,
  })

  const shells = useShells({ app: props.app, threadId: conversation.threadId })

  const { lost } = conversation

  const handleShowLostAgents = useCallback((): boolean => {
    if (!hasLostChildren(lost)) return false

    setPanel(EChromePanel.LostAgents)
    return true
  }, [lost])

  /**
   * Raised by the open rather than asked for, because nothing else in the conversation will ever
   * mention these: a child with no `agent-spawned` behind it is absent from the log the transcript
   * is built from and from the roster the sidebar reads.
   */
  useEffect(() => {
    if (!hasLostChildren(lost)) return

    setPanel(EChromePanel.LostAgents)
  }, [lost])

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
    thinking: settings.thinking,
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
   * Nothing said yet is a state of its own, not an empty transcript: the wordmark and the composer
   * sit centred with the whole terminal to themselves, and the sidebar stays away until there is a
   * conversation for it to read.
   */
  const welcome = welcoming({
    model: agentView.transcript ?? conversation.model,
    addressingChild: agentView.viewing !== null,
  })
  const sidebarVisible = !welcome && sidebarShown({ layout, peeking })
  const overlay = sidebarVisible && !wide
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

  const accounts = useAccounts({ accounts: props.app.accounts, openUrl: props.app.openUrl })
  const accountsOpen = accounts.state !== null
  const accountRows = accounts.state?.rows

  useEffect(() => {
    if (!accountsOpen) return
    for (const row of accountRows ?? []) void usage.refresh({ accountId: row.account.id })
  }, [accountRows, accountsOpen, usage])

  const accountMeters = useCallback(
    (row: AccountRow): readonly Span[] =>
      accountMeterSpans({
        usage: usage.snapshotFor({ accountId: row.account.id }),
        warn: settings.usageWarn,
        now: Date.now(),
      }),
    [settings.usageWarn, usage],
  )

  /**
   * A session that opened with nothing it can authenticate with shows the accounts overlay rather
   * than waiting for the first turn to fail with the same message.
   */
  const { credentialNotice } = props
  const notified = useRef(false)
  useEffect(() => {
    if (credentialNotice === null || notified.current) return

    notified.current = true
    accounts.handleOpen(credentialNotice)
  }, [accounts, credentialNotice])

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

  // OpenTUI parses a whole input burst before React re-renders, so a paste — or ⏎ arriving in the
  // same burst as the text — reaches here with `draft.value` still empty. The buffer is the truth.
  const commands = useMemo(
    () =>
      localCommands({
        onCompact: conversation.handleCompact,
        onRewind: rewind.handleOpen,
        onShortcuts: () => setPanel(EChromePanel.Shortcuts),
        onOpenSwitcher: switcher.handleOpen,
        onOpenShells: () => shells.handleOpen(),
        onOpenAgents: agentsPicker.handleOpen,
        onShowAgentTypes: () => setPanel(EChromePanel.AgentTypes),
        onShowLostAgents: handleShowLostAgents,
        onOpenSettings: settings.handleOpen,
        onOpenAccounts: () => accounts.handleOpen(),
        onNewConversation: handleNewConversation,
        onOpenThreads: handleResumeConversation,
        onRename: conversation.handleRename,
        onReloadSkills: handleReloadSkills,
      }),
    [
      accounts,
      agentsPicker.handleOpen,
      conversation.handleCompact,
      conversation.handleRename,
      handleNewConversation,
      handleReloadSkills,
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
   * The tag goes in at the cursor and the buffer is read straight back, because OpenTUI's editor
   * owns the text and only mirrors it into React on its own change event.
   */
  /**
   * The tag is written as a `virtual` extmark, which is what makes it one thing to the cursor rather
   * than ten characters: OpenTUI's `ExtmarksController` wraps the buffer's own motion and deletion —
   * left, right, visual up and down, backspace, delete, selection delete, undo and redo — so every
   * one of them steps over the span whole instead of into it. Teaching those keys about tags by hand
   * would be a worse copy of a mechanism the editor already has.
   */
  /**
   * A draft taken back out of the queue arrives as plain text, so its tags come back without the
   * extmarks that made them whole. They are re-marked here, or a picture that survived a take-back
   * would be the one the cursor could still walk into.
   */
  /**
   * Extmarks make every motion the editor owns step over a tag whole, but a click sets the caret by
   * row and column rather than by offset, so it lands where it was clicked. A caret that ends up
   * inside a tag is put back out by the nearer edge — the one door the editor cannot close itself.
   */
  const handleCursorMoved = useCallback(() => {
    const editor = draft.editor.current
    if (editor === null) return

    const inside = imageTagAround({ text: editor.plainText, offset: editor.cursorOffset })
    if (inside === null) return

    editor.cursorOffset = nearerEdgeOf({ span: inside, offset: editor.cursorOffset })
  }, [draft])

  const markImageTags = useCallback(
    (text: string) => {
      const editor = draft.editor.current
      if (editor === null) return

      editor.extmarks.clear()
      for (const span of imageTagSpans(text)) {
        editor.extmarks.create({ start: span.start, end: span.end, virtual: true })
      }
    },
    [draft],
  )

  const handleAttachImage = useCallback((): boolean => {
    void attachments.handleAttach().then((image) => {
      if (image === null) return

      const editor = draft.editor.current
      if (editor === null) return

      const tag = imageTag(image.ordinal)
      const start = editor.cursorOffset

      editor.insertText(`${tag} `)
      editor.extmarks.create({ start, end: start + tag.length, virtual: true })
      draft.sync(editor.plainText)
    })

    return true
  }, [attachments, draft])

  const imageTags = useMemo(() => imageTagSpans(draft.value), [draft.value])

  const highlights = useMemo(() => [...mentionSpans, ...imageTags], [imageTags, mentionSpans])


  const handleSubmit = useCallback(() => {
    const said = draft.editor.current?.plainText ?? draft.value
    const attached = attachments.images
    if (said.trim().length === 0 && attached.length === 0) {
      handleOpenNewest()
      return
    }

    draft.clear()
    attachments.clear()
    setSends((count) => count + 1)

    const putBack = () => {
      draft.setValue(said)
      attachments.restore(attached)
    }

    if (agentView.viewing !== null) {
      const spoken = submissionOf({ text: said, images: attached, load: readImageBase64 })
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
      ...(props.app.files === undefined ? {} : { loadFile: workspaceFileLoader(props.app.files) }),
    }).then((dispatched) => {
      if (dispatched.type === EDispatch.Refused) {
        putBack()
        conversation.handleReportProblem(dispatched.reason)
        return
      }
      if (dispatched.type === EDispatch.Ran) {
        attachments.restore(attached)
        if (dispatched.notice !== undefined) notify({ text: dispatched.notice })
        return
      }
      if (dispatched.type !== EDispatch.Send) return

      const sending = submissionOf({
        text: dispatched.text,
        images: attached,
        load: readImageBase64,
      })
      conversation.handleSend({ ...sending, context: dispatched.drafts })
    })
  }, [
    agentView,
    attachments,
    commands,
    conversation,
    draft,
    handleOpenNewest,
    props.app.files,
    skills,
  ])

  /**
   * The draft is asked for its buffer rather than its mirror because OpenTUI parses a whole input
   * burst before React re-renders, so a `?` pasted after text would otherwise read as empty.
   */
  const draftIsEmpty = useCallback(
    (): boolean => (draft.editor.current?.plainText ?? draft.value).length === 0,
    [draft],
  )

  const handleTakeBackPending = useCallback((): boolean => {
    const taken = conversation.handleTakeBackPending()
    if (taken === null) return false

    draft.setValue(taken.text)
    markImageTags(taken.text)
    attachments.restore(restoredImages({ images: taken.images, text: taken.text }))
    return true
  }, [attachments, conversation, draft, markImageTags])

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

    if (shells.running + agents.running > 0) {
      exitGuard.handleOpen()
      return
    }

    renderer.destroy()
  }, [agents.running, conversation, exitGuard, renderer, shells])

  useEffect(() => {
    if (exitGuard.state !== null && shells.running + agents.running === 0) exitGuard.handleDismiss()
  }, [agents.running, exitGuard, shells.running])

  useKeyBindings(
    globalBindings({
      draftIsEmpty,
      onSubmit: handleSubmit,
      onShortcuts: () => setPanel(EChromePanel.Shortcuts),
      onTakeBackPending: handleTakeBackPending,
      onInterrupt: conversation.handleInterrupt,
      onOpenSwitcher: switcher.handleOpen,
      onAttachImage: handleAttachImage,
      onOpenShells: () => shells.handleOpen(),
      onCycleAgents: agents.count === 0 ? null : agentView.handleCycle,
      onToggleSidebar: wide ? null : handleToggleSidebar,
      onOpenSettings: settings.handleOpen,
      onOpenAccounts: () => accounts.handleOpen(),
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

  const handleKey = useOverlayKeys({
    veil: { shown: panel !== null, dismiss: () => setPanel(null), keys: [HELP_KEY] },
    owners: [
      { open: exitGuard.state !== null, handleKey: exitGuard.handleKey },
      { open: rewind.state !== null, handleKey: rewind.handleKey },
      { open: switcher.state !== null, handleKey: switcher.handleKey },
      { open: shells.state !== null, handleKey: shells.handleKey },
      { open: accounts.state !== null, handleKey: accounts.handleKey },
      { open: threads.state !== null, handleKey: threads.handleKey },
      { open: agentsPicker.state !== null, handleKey: agentsPicker.handleKey },
      { open: settings.state !== null, handleKey: settings.handleKey, porous: true },
    ],
    bindings: registry.snapshot,
  })

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

  /**
   * Anything covering the composer must take focus with it: the terminal cursor is not part of the
   * character grid, so a focused textarea keeps drawing its caret straight through whatever is
   * painted over it.
   */
  const overlaid =
    props.covered ||
    overlay ||
    exitGuard.state !== null ||
    switcher.state !== null ||
    accounts.state !== null ||
    threads.state !== null ||
    agentsPicker.state !== null ||
    settings.state !== null ||
    shells.state !== null ||
    rewind.state !== null ||
    conversation.compacting !== null

  /**
   * Which overlays a picture has to be withheld for.
   *
   * Every one of these paints across the transcript, and a kitty image cannot be layered over — the
   * terminal composites it above the text plane whatever z-order was asked for. The sidebar is left
   * out on purpose: it narrows the transcript rather than covering it, so the picture beside it is
   * still worth showing.
   */
  const picturesCovered =
    props.covered ||
    exitGuard.state !== null ||
    switcher.state !== null ||
    accounts.state !== null ||
    threads.state !== null ||
    agentsPicker.state !== null ||
    settings.state !== null ||
    shells.state !== null ||
    rewind.state !== null ||
    conversation.compacting !== null

  useEffect(() => {
    applyTranscriptCovered(picturesCovered)
  }, [picturesCovered])

  /**
   * The terminal's own paste is the gesture that carries a picture, whatever key it is bound to —
   * ⌘V here, ctrl+v in Warp. It arrives with no text, because a terminal asked to paste an image has
   * nothing to send, so the empty paste is what a screenshot looks like from inside the app. It is
   * ignored while the composer is covered, because then the draft is not what the paste is aimed at.
   */
  usePaste(
    useCallback(
      (event: PasteEvent) => {
        if (overlaid || !isEmptyPaste(event)) return

        event.preventDefault()
        event.stopPropagation()
        handleAttachImage()
      },
      [handleAttachImage, overlaid],
    ),
  )

  return (
    <Screen>
      <SelectionSurface>
        <box flexDirection="column" width={contentWidth} flexGrow={1} flexShrink={1} flexBasis={0}>
          <box flexGrow={welcome ? 1 : 0} flexShrink={1} />
          {welcome ? (
            <WelcomeScreen
              cwd={props.app.config.cwd}
              home={homedir()}
              modelId={selection.modelId}
              width={contentWidth}
            />
          ) : (
            <Transcript
              model={agentView.transcript ?? conversation.model}
              width={contentWidth}
              now={conversation.now}
              cwd={props.app.config.cwd}
              turn={conversation.turn}
              sends={sends}
              pending={conversation.pending}
              {...(conversation.handleRetry === null ? {} : { onRetry: conversation.handleRetry })}
              {...(conversation.handleResume === null
                ? {}
                : { onResume: conversation.handleResume })}
              opened={opened}
              onToggle={handleToggle}
            />
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
              placeholder={composerPlaceholder({
                addressingChild: agentView.viewing !== null,
                working: conversation.working,
              })}
              maxRows={composerRows(height)}
              focused={!overlaid}
              highlights={highlights}
              onCursorMoved={handleCursorMoved}
              {...(agentView.name === null
                ? conversation.handle === null
                  ? {}
                  : { title: conversation.handle }
                : { title: `@${agentView.name}`, titleFg: theme.court.external })}
            />
          </box>
          <box flexGrow={welcome ? 1 : 0} flexShrink={1} />
          <Footer
            width={chromeWidth}
            model={entry?.label ?? modelLabel(selection.modelId)}
            effort={selection.effort}
            {...(readout === null ? {} : { context: readout })}
          />
        </box>
        {sidebarVisible ? (
          <Sidebar
            width={overlay ? floatingSidebarWidth({ width, sidebarWidth }) : sidebarWidth}
            model={agents.sidebar}
            turn={conversation.turn}
            now={conversation.now}
            cwd={conversation.projectDirectory}
            overlay={overlay}
            shells={shells.folded}
            shellFold={shells.fold}
            onOpenShell={shells.handleOpen}
            onSelectSubagent={agentView.handleSelect}
          />
        ) : null}
        <OverlayStack
          width={width}
          contentWidth={contentWidth}
          cwd={props.app.config.cwd}
          activeModelId={activeModelId}
          accountMeters={accountMeters}
          switcher={switcher}
          shells={shells}
          agents={agents}
          settings={settings}
          accounts={accounts}
          threads={threads}
          agentsPicker={agentsPicker}
          rewind={rewind}
          exitGuard={exitGuard}
          compacting={conversation.compacting}
          now={conversation.now}
        />
      </SelectionSurface>
    </Screen>
  )
}
