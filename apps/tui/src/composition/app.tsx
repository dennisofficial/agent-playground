import { homedir } from 'node:os'

import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react'
import React, { useCallback, useState, useSyncExternalStore } from 'react'

import { contextPressure, MODEL_CATALOG, modelEntry, type ModelEntry } from '@dltech/atlas-core'

import { newestExpandableKey } from '../store'
import { Composer, composerRows, composerTone } from '../ui/components/composer'
import { Footer, type FooterContext } from '../ui/components/footer'
import { Screen } from '../ui/components/screen'
import { Settings } from '../ui/components/settings'
import { Shortcuts } from '../ui/components/shortcuts'
import { Sidebar, ESidebarPreference } from '../ui/components/sidebar'
import { Switcher } from '../ui/components/switcher'
import { Transcript } from '../ui/components/transcript'
import { useDraft } from '../ui/hooks/use-draft'
import { modelLabel } from '../ui/model-label'
import { densityVersion, subscribeDensity } from '../ui/density-store'
import { paletteVersion, subscribePalette } from '../ui/palette-store'
import {
  adjustEffort,
  moveSelection,
  openSwitcher,
  resolve,
  type SwitcherChoice,
  type SwitcherState,
} from '../ui/switcher-model'
import { SIDEBAR_GUTTER, SIDEBAR_MIN_TERMINAL_WIDTH } from '../ui/theme'
import type { AtlasApp } from './compose'
import { modelIsReachable, type ModelSelection } from './model-selection'
import type { OpenedConversation } from './open-conversation'
import { useConversation } from './use-conversation'
import { useSettings } from './use-settings'

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
  const [switcher, setSwitcher] = useState<SwitcherState | null>(null)
  const [shortcuts, setShortcuts] = useState(false)
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

  const handleOpenSwitcher = useCallback(() => {
    setSwitcher(
      openSwitcher({
        models: MODEL_CATALOG,
        activeModelId,
        effort: selection.effort,
        availability: modelIsReachable,
      }),
    )
  }, [activeModelId, selection.effort])

  const handleDismissSwitcher = useCallback(() => setSwitcher(null), [])

  const handlePick = useCallback(
    (choice: SwitcherChoice) => {
      setSwitcher(null)
      if (choice.modelId === null) return

      props.app.model.select({ modelId: choice.modelId, effort: choice.effort })
      setSelection(props.app.model.choice())
    },
    [props.app.model],
  )

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
  const handleSubmit = useCallback(() => {
    const said = draft.editor.current?.plainText ?? draft.value
    if (said.trim().length === 0) {
      handleOpenNewest()
      return
    }

    draft.clear()
    conversation.handleSend(said)
  }, [conversation, draft, handleOpenNewest])

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

  useKeyboard((key) => {
    if (key.eventType === 'release') return

    if (shortcuts) {
      setShortcuts(false)
      if (key.name === 'escape' || key.sequence === HELP_KEY) {
        key.preventDefault()
        return
      }
    }

    if (switcher !== null) {
      key.preventDefault()

      if (key.name === 'escape') {
        handleDismissSwitcher()
        return
      }

      if (key.name === 'return') {
        handlePick(resolve({ state: switcher, models: MODEL_CATALOG }))
        return
      }

      if (key.name === 'up' || key.name === 'down') {
        setSwitcher(
          moveSelection({
            state: switcher,
            delta: key.name === 'up' ? -1 : 1,
            models: MODEL_CATALOG,
            availability: modelIsReachable,
          }),
        )
        return
      }

      if (key.name === 'left' || key.name === 'right') {
        setSwitcher(adjustEffort({ state: switcher, delta: key.name === 'left' ? -1 : 1 }))
      }

      return
    }

    if (settings.state !== null) {
      settings.handleKey(key)
      return
    }

    if (key.ctrl && key.name === 'o') {
      key.preventDefault()
      settings.handleOpen()
      return
    }

    if (key.ctrl && key.name === 'p') {
      key.preventDefault()
      handleOpenSwitcher()
      return
    }

    if (key.sequence === HELP_KEY && !key.ctrl && !key.meta && draftIsEmpty()) {
      key.preventDefault()
      setShortcuts(true)
      return
    }

    if (key.name === 'return' && !key.shift && !key.ctrl && !key.meta) {
      key.preventDefault()
      handleSubmit()
      return
    }

    if (key.name === 'up' && !key.ctrl && !key.meta && draftIsEmpty() && handleTakeBackPending()) {
      key.preventDefault()
      return
    }

    if (key.name === 'escape') {
      key.preventDefault()
      conversation.handleInterrupt()
      return
    }

    if (key.ctrl && key.name === 'n') {
      key.preventDefault()
      handleNewConversation()
      return
    }

    if (key.ctrl && key.name === 'b') {
      key.preventDefault()
      handleToggleSidebar()
      return
    }

    if (key.ctrl && key.name === 'c') {
      key.preventDefault()
      if (conversation.working) {
        conversation.handleInterrupt()
        return
      }
      renderer.destroy()
    }
  })

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
            pending={conversation.pending}
            onRetry={conversation.handleRetry}
            opened={opened}
            onToggle={handleToggle}
          />
          {shortcuts ? <Shortcuts width={chromeWidth} /> : null}
          <Composer
            draft={draft}
            width={chromeWidth}
            tone={tone}
            placeholder={conversation.working ? STEER_PLACEHOLDER : PLACEHOLDER}
            maxRows={composerRows(height)}
            focused={switcher === null && settings.state === null}
          />
          <Footer
            width={chromeWidth}
            model={entry?.label ?? modelLabel(selection.modelId)}
            effort={selection.effort}
            {...(readout === null ? {} : { context: readout })}
          />
        </box>
        {switcher === null ? null : (
          <Switcher
            width={Math.min(settings.sidebarWidth, width)}
            models={MODEL_CATALOG}
            state={switcher}
            activeModelId={activeModelId}
            availability={modelIsReachable}
            overlay
            onPick={handlePick}
            onDismiss={handleDismissSwitcher}
          />
        )}
        {sidebarVisible ? (
          <Sidebar
            width={settings.sidebarWidth}
            model={conversation.sidebar}
            turn={conversation.turn}
            now={conversation.now}
            cwd={props.app.config.cwd}
            overlay={overlay}
          />
        ) : null}
        {settings.state === null ? null : (
          <Settings
            width={width}
            sidebarWidth={Math.min(settings.sidebarWidth, width)}
            model={settings.view}
            state={settings.state}
            cwd={props.app.config.cwd}
            origin={settings.origin}
            problem={settings.problem}
            onActivate={settings.handleActivate}
            onDismiss={settings.handleDismiss}
          />
        )}
      </box>
    </Screen>
  )
}
