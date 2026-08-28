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
import { Sidebar, ESidebarPreference } from '../ui/components/sidebar'
import { Transcript } from '../ui/components/transcript'
import { useDraft } from '../ui/hooks/use-draft'
import { modelLabel } from '../ui/model-label'
import { densityVersion, subscribeDensity } from '../ui/density-store'
import { paletteVersion, subscribePalette } from '../ui/palette-store'
import { ERewindVerb, type RewindChoice } from '../ui/rewind-model'
import type { SwitcherChoice } from '../ui/switcher-model'
import { SIDEBAR_GUTTER, SIDEBAR_MIN_TERMINAL_WIDTH } from '../ui/theme'
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
import { useOverlayKeys } from './use-overlay-keys'
import { useSettings } from './use-settings'
import { useShells } from './use-shells'
import { useRewind } from './use-rewind'
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

export function App(props: { app: AtlasApp; opened: OpenedConversation }): React.ReactNode {
  const registry = useMemo(() => createKeyRegistry(), [])

  return (
    <KeyRegistryContext.Provider value={registry}>
      <Workspace app={props.app} opened={props.opened} />
    </KeyRegistryContext.Provider>
  )
}

function Workspace(props: { app: AtlasApp; opened: OpenedConversation }): React.ReactNode {
  const renderer = useRenderer()
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
  })

  const [preference, setPreference] = useState<ESidebarPreference>(ESidebarPreference.Auto)
  const [forcedOpen, setForcedOpen] = useState(false)
  const wide = width > SIDEBAR_MIN_TERMINAL_WIDTH
  const sidebarVisible = forcedOpen || (preference === ESidebarPreference.Auto && wide)
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

  const handleRewindChoice = useCallback(
    ({ point, verb }: RewindChoice) => {
      if (verb === ERewindVerb.ToHere) {
        conversation.handleRewindTo(point.seq - 1)
        draft.setValue(point.text)
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
        onNewConversation: handleNewConversation,
      }),
    [
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
    setForcedOpen(!sidebarVisible)
    setPreference(sidebarVisible ? ESidebarPreference.Hidden : ESidebarPreference.Auto)
  }, [sidebarVisible])

  const handleQuit = useCallback(() => {
    if (conversation.working) {
      conversation.handleInterrupt()
      return
    }
    renderer.destroy()
  }, [conversation, renderer])

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
      onQuit: handleQuit,
    }),
  )

  const registry = useKeyRegistry()

  const handleKey = useOverlayKeys({
    veil: { shown: shortcuts, dismiss: () => setShortcuts(false), keys: [HELP_KEY] },
    owners: [
      { open: rewind.state !== null, handleKey: rewind.handleKey },
      { open: switcher.state !== null, handleKey: switcher.handleKey },
      { open: shells.state !== null, handleKey: shells.handleKey },
      { open: settings.state !== null, handleKey: settings.handleKey, porous: true },
    ],
    bindings: registry.snapshot,
  })

  const handleKeyWithMenu = useCallback(
    (key: KeyEvent) => {
      if (commandMenu.handleKey(key)) {
        key.preventDefault()
        return
      }

      handleKey(key)
    },
    [commandMenu, handleKey],
  )

  useKeyboard(handleKeyWithMenu)

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
            {...(conversation.compacting === null
              ? {}
              : { compacting: conversation.compacting })}
            {...(conversation.handleRetry === null
              ? {}
              : { onRetry: conversation.handleRetry })}
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
            focused={
              switcher.state === null &&
              settings.state === null &&
              shells.state === null &&
              rewind.state === null
            }
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
          rewind={rewind}
        />
      </box>
    </Screen>
  )
}
