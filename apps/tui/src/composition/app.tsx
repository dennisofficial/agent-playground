import { homedir } from 'node:os'

import type { KeyEvent } from '@opentui/core'
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react'
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { contextPressure, ECompactionAnchor, modelEntry, type ModelEntry } from '@dltech/atlas-core'

import { newestExpandableKey } from '../store'
import { CommandMenu } from '../ui/components/command-menu'
import { Composer, composerRows, composerTone } from '../ui/components/composer'
import { Footer, type FooterContext } from '../ui/components/footer'
import { Screen } from '../ui/components/screen'
import { Shortcuts } from '../ui/components/shortcuts'
import { Sidebar } from '../ui/components/sidebar'
import { Transcript } from '../ui/components/transcript'
import { useDraft } from '../ui/hooks/use-draft'
import { modelLabel } from '../ui/model-label'
import { densityVersion, subscribeDensity } from '../ui/density-store'
import { paletteVersion, subscribePalette } from '../ui/palette-store'
import { ERewindPointKind, ERewindVerb, type RewindChoice } from '../ui/rewind-model'
import type { SwitcherChoice } from '../ui/switcher-model'
import { SIDEBAR_GUTTER } from '../ui/theme'
import {
  ESidebarLayout,
  flipSidebar,
  sidebarChoiceInForce,
  sidebarLayout,
  sidebarShown,
  type SidebarChoice,
} from '../ui/sidebar-visibility'
import {
  createKeyRegistry,
  KeyRegistryContext,
  useKeyBindings,
  useKeyRegistry,
} from '../ui/keys'
import { commandSpecs, dispatchSubmission, EDispatch, localCommands } from './commands'
import { useCommandMenu } from './use-command-menu'
import type { AtlasApp } from './compose'
import { globalBindings } from './global-bindings'
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
import { useSwitcher } from './use-switcher'

const PLACEHOLDER = 'Ask anything'

const STEER_PLACEHOLDER = 'Steer the turn'

const HELP_KEY = '?'

const readoutOf = (args: { entry: ModelEntry | undefined; used: number }): FooterContext | null => {
  const { entry } = args
  if (entry === undefined) return null

  const pressure = contextPressure({ used: args.used, window: entry.contextWindow })
  return { percent: pressure.percent, tokensLeft: Math.max(0, entry.contextWindow - args.used) }
}

export function App(props: {
  app: AtlasApp
  opened: OpenedConversation
  credentialNotice?: string | null
  covered?: boolean
}): React.ReactNode {
  const registry = useMemo(() => createKeyRegistry(), [])

  return (
    <KeyRegistryContext.Provider value={registry}>
      <Workspace
        app={props.app}
        opened={props.opened}
        credentialNotice={props.credentialNotice ?? null}
        covered={props.covered === true}
      />
    </KeyRegistryContext.Provider>
  )
}

function Workspace(props: {
  app: AtlasApp
  opened: OpenedConversation
  credentialNotice: string | null
  covered: boolean
}): React.ReactNode {
  const renderer = useRenderer()
  const exitGuard = useExitGuard({ onExit: () => renderer.destroy() })
  const { width, height } = useTerminalDimensions()
  useSyncExternalStore(subscribePalette, paletteVersion)
  useSyncExternalStore(subscribeDensity, densityVersion)

  const settings = useSettings({ app: props.app })

  const draft = useDraft()

  const conversation = useConversation({
    app: props.app,
    opened: props.opened,
    paceReveal: settings.paceReveal,
    autoCompactAtPercent: settings.autoCompactAtPercent,
    thinking: settings.thinking,
    onUndone: draft.setValue,
    canWake: exitGuard.state === null,
  })

  const [sidebarChoice, setSidebarChoice] = useState<SidebarChoice | null>(null)
  const layout = sidebarLayout(width)
  const wide = layout === ESidebarLayout.Wide
  const sidebarVisible = sidebarShown({ layout, choice: sidebarChoice })
  const docked = sidebarVisible && wide
  const overlay = sidebarVisible && !wide
  const contentWidth = width - (docked ? settings.sidebarWidth : 0)
  const chromeWidth = contentWidth - (docked ? SIDEBAR_GUTTER : 0)

  const tone = composerTone({
    working: conversation.working,
    interrupting: conversation.turn.interrupting,
  })

  const [selection, setSelection] = useState<ModelSelection>(() => props.app.model.choice())
  const [shortcuts, setShortcuts] = useState(false)
  const [sends, setSends] = useState(0)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set<string>())

  /**
   * A configured model id carries its release stamp; the catalog is keyed without one, so every
   * reading of "what is answering" goes through the entry rather than the raw id.
   */
  const entry = modelEntry(selection.modelId)
  const activeModelId = entry?.id ?? selection.modelId

  const readout = readoutOf({ entry, used: conversation.contextTokens })

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

  const shells = useShells({ app: props.app })

  const accounts = useAccounts({ accounts: props.app.accounts })

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

  // OpenTUI parses a whole input burst before React re-renders, so a paste — or ⏎ arriving in the
  // same burst as the text — reaches here with `draft.value` still empty. The buffer is the truth.
  const commands = useMemo(
    () =>
      localCommands({
        onCompact: conversation.handleCompact,
        onRewind: rewind.handleOpen,
        onShortcuts: () => setShortcuts(true),
        onOpenSwitcher: switcher.handleOpen,
        onOpenShells: () => shells.handleOpen(),
        onOpenSettings: settings.handleOpen,
        onOpenAccounts: () => accounts.handleOpen(),
        onNewConversation: handleNewConversation,
      }),
    [
      accounts,
      conversation.handleCompact,
      handleNewConversation,
      rewind.handleOpen,
      settings.handleOpen,
      shells,
      switcher.handleOpen,
    ],
  )

  const skills = useMemo(
    () => props.app.skills.filter((skill) => skill.userInvocable),
    [props.app.skills],
  )

  const specs = useMemo(() => commandSpecs({ commands, skills }), [commands, skills])

  const commandMenu = useCommandMenu({ specs, onComplete: draft.setValue })
  const readDraft = useRef(commandMenu.handleTextChanged)
  readDraft.current = commandMenu.handleTextChanged

  useEffect(() => {
    readDraft.current(draft.value)
  }, [draft.value])

  const handleSubmit = useCallback(() => {
    const said = draft.editor.current?.plainText ?? draft.value
    if (said.trim().length === 0) {
      handleOpenNewest()
      return
    }

    draft.clear()
    setSends((count) => count + 1)

    void dispatchSubmission({
      text: said,
      commands,
      skills,
      working: conversation.working,
    }).then((dispatched) => {
      if (dispatched.type === EDispatch.Refused) {
        draft.setValue(said)
        conversation.handleReportProblem(dispatched.reason)
        return
      }
      if (dispatched.type !== EDispatch.Send) return

      conversation.handleSend(dispatched.text, dispatched.drafts)
    })
  }, [commands, conversation, draft, handleOpenNewest, skills])

  /**
   * The draft is asked for its buffer rather than its mirror because OpenTUI parses a whole input
   * burst before React re-renders, so a `?` pasted after text would otherwise read as empty.
   */
  const draftIsEmpty = useCallback(
    (): boolean => (draft.editor.current?.plainText ?? draft.value).length === 0,
    [draft],
  )

  const handleTakeBackPending = useCallback((): boolean => {
    const text = conversation.handleTakeBackPending()
    if (text === null) return false

    draft.setValue(text)
    return true
  }, [conversation, draft])

  const handleToggleSidebar = useCallback(() => {
    setSidebarChoice((choice) => flipSidebar({ layout, choice }))
  }, [layout])

  useEffect(() => {
    setSidebarChoice((choice) => sidebarChoiceInForce({ layout, choice }))
  }, [layout])

  const handleQuit = useCallback(() => {
    if (conversation.working) {
      conversation.handleInterrupt()
      return
    }

    if (shells.running > 0) {
      exitGuard.handleOpen()
      return
    }

    renderer.destroy()
  }, [conversation, exitGuard, renderer, shells])

  useEffect(() => {
    if (exitGuard.state !== null && shells.running === 0) exitGuard.handleDismiss()
  }, [exitGuard, shells.running])

  useKeyBindings(
    globalBindings({
      draftIsEmpty,
      onSubmit: handleSubmit,
      onShortcuts: () => setShortcuts(true),
      onTakeBackPending: handleTakeBackPending,
      onInterrupt: conversation.handleInterrupt,
      onNewConversation: handleNewConversation,
      onOpenSwitcher: switcher.handleOpen,
      onOpenShells: () => shells.handleOpen(),
      onToggleSidebar: handleToggleSidebar,
      onOpenSettings: settings.handleOpen,
      onOpenAccounts: () => accounts.handleOpen(),
      onQuit: handleQuit,
    }),
  )

  const registry = useKeyRegistry()

  const handleKey = useOverlayKeys({
    veil: { shown: shortcuts, dismiss: () => setShortcuts(false), keys: [HELP_KEY] },
    owners: [
      { open: exitGuard.state !== null, handleKey: exitGuard.handleKey },
      { open: rewind.state !== null, handleKey: rewind.handleKey },
      { open: switcher.state !== null, handleKey: switcher.handleKey },
      { open: shells.state !== null, handleKey: shells.handleKey },
      { open: accounts.state !== null, handleKey: accounts.handleKey },
      { open: settings.state !== null, handleKey: settings.handleKey, porous: true },
    ],
    bindings: registry.snapshot,
  })

  const handleKeyWithMenu = useCallback(
    (key: KeyEvent) => {
      if (props.covered) return

      if (commandMenu.handleKey(key)) {
        key.preventDefault()
        return
      }

      handleKey(key)
    },
    [commandMenu, handleKey, props.covered],
  )

  useKeyboard(handleKeyWithMenu)

  /**
   * Anything covering the composer must take focus with it: the terminal cursor is not part of the
   * character grid, so a focused textarea keeps drawing its caret straight through whatever is
   * painted over it.
   */
  const overlaid =
    props.covered ||
    exitGuard.state !== null ||
    switcher.state !== null ||
    accounts.state !== null ||
    settings.state !== null ||
    shells.state !== null ||
    rewind.state !== null ||
    conversation.compacting !== null

  return (
    <Screen>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0}>
        <box flexDirection="column" width={contentWidth} flexGrow={1} flexShrink={1} flexBasis={0}>
          <Transcript
            model={conversation.model}
            width={contentWidth}
            now={conversation.now}
            cwd={props.app.config.cwd}
            home={homedir()}
            modelId={selection.modelId}
            turn={conversation.turn}
            sends={sends}
            pending={conversation.pending}
            {...(conversation.handleRetry === null
              ? {}
              : { onRetry: conversation.handleRetry })}
            {...(conversation.handleResume === null
              ? {}
              : { onResume: conversation.handleResume })}
            {...(conversation.handleResumeFresh === null
              ? {}
              : { onResumeFresh: conversation.handleResumeFresh })}
            opened={opened}
            onToggle={handleToggle}
          />
          {shortcuts ? <Shortcuts width={chromeWidth} /> : null}
          {commandMenu.state === null ? null : (
            <CommandMenu state={commandMenu.state} width={chromeWidth} />
          )}
          <Composer
            draft={draft}
            width={chromeWidth}
            tone={tone}
            placeholder={conversation.working ? STEER_PLACEHOLDER : PLACEHOLDER}
            maxRows={composerRows(height)}
            focused={!overlaid}
            {...(conversation.sidebar.title === null
              ? {}
              : { title: conversation.sidebar.title })}
          />
          <Footer
            width={chromeWidth}
            model={entry?.label ?? modelLabel(selection.modelId)}
            effort={selection.effort}
            {...(readout === null ? {} : { context: readout })}
          />
        </box>
        {sidebarVisible ? (
          <Sidebar
            width={settings.sidebarWidth}
            model={conversation.sidebar}
            turn={conversation.turn}
            now={conversation.now}
            cwd={props.app.config.cwd}
            sessionDirectory={conversation.sessionDirectory}
            overlay={overlay}
            shells={shells.shells}
            onOpenShell={shells.handleOpen}
          />
        ) : null}
        <OverlayStack
          width={width}
          contentWidth={contentWidth}
          cwd={props.app.config.cwd}
          activeModelId={activeModelId}
          switcher={switcher}
          shells={shells}
          settings={settings}
          accounts={accounts}
          rewind={rewind}
          exitGuard={exitGuard}
          compacting={conversation.compacting}
          now={conversation.now}
        />
      </box>
    </Screen>
  )
}
