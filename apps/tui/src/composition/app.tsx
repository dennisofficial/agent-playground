import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react'
import React, { useCallback, useSyncExternalStore } from 'react'

import { Composer, composerRows } from '../ui/components/composer'
import { Screen } from '../ui/components/screen'
import { Transcript } from '../ui/components/transcript'
import { useDraft } from '../ui/hooks/use-draft'
import { paletteVersion, subscribePalette } from '../ui/palette-store'
import { theme } from '../ui/theme'
import type { AtlasApp } from './compose'
import type { OpenedConversation } from './open-conversation'
import { useConversation } from './use-conversation'

const PLACEHOLDER = 'Ask anything'

const HINTS = '⏎ send · ⇧⏎ newline · esc interrupt · ctrl+n new · ctrl+c quit'

export function App(props: { app: AtlasApp; opened: OpenedConversation }): React.ReactNode {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  useSyncExternalStore(subscribePalette, paletteVersion)

  const conversation = useConversation({ app: props.app, opened: props.opened })
  const draft = useDraft()

  // OpenTUI parses a whole input burst before React re-renders, so a paste — or ⏎ arriving in the
  // same burst as the text — reaches here with `draft.value` still empty. The buffer is the truth.
  const handleSubmit = useCallback(() => {
    const said = draft.editor.current?.plainText ?? draft.value
    if (said.trim().length === 0) return

    draft.clear()
    conversation.handleSend(said)
  }, [conversation, draft])

  const handleNewConversation = useCallback(() => {
    draft.clear()
    conversation.handleNewConversation()
  }, [conversation, draft])

  useKeyboard((key) => {
    if (key.eventType === 'release') return

    if (key.name === 'return' && !key.shift && !key.ctrl && !key.meta) {
      key.preventDefault()
      handleSubmit()
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
    <Screen
      footer={
        <box flexDirection="column" width={width} flexShrink={0}>
          <Composer
            draft={draft}
            width={width}
            placeholder={PLACEHOLDER}
            maxRows={composerRows(height)}
          />
          <text fg={theme.dim}>{HINTS}</text>
        </box>
      }
    >
      <Transcript
        model={conversation.model}
        width={width}
        now={conversation.now}
        cwd={props.app.config.cwd}
        turn={conversation.turn}
      />
    </Screen>
  )
}
