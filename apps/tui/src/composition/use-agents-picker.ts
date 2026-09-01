import type { ThreadId } from '@dltech/atlas-core'
import type { KeyEvent } from '@opentui/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  moveAgentSelection,
  openedAgents,
  selectedAgent,
  type AgentPickerRow,
  type AgentsPickerState,
} from '../ui/agents-picker-model'
import { agentChoices } from './commands'
import type { AtlasApp } from './compose'

export type AgentsPickerControl = {
  state: AgentsPickerState | null
  handleOpen: () => boolean
  handleDismiss: () => void
  handlePick: (row: AgentPickerRow) => void
  handleKey: (key: KeyEvent) => void
}

export function useAgentsPicker(args: {
  app: AtlasApp
  threadId: ThreadId
  onPick: (agentId: string) => void
}): AgentsPickerControl {
  const { app, threadId, onPick } = args
  const held = useRef<AgentsPickerState | null>(null)
  const [state, setState] = useState<AgentsPickerState | null>(null)

  const put = useCallback((next: AgentsPickerState | null) => {
    held.current = next
    setState(next)
  }, [])

  useEffect(() => put(null), [put, threadId])

  const handleOpen = useCallback((): boolean => {
    const rows = agentChoices({ agents: app.agents.list({ threadId }) })
    if (rows.length === 0) return false

    put(openedAgents({ rows }))
    return true
  }, [app.agents, put, threadId])

  const handleDismiss = useCallback(() => put(null), [put])

  const handlePick = useCallback(
    (row: AgentPickerRow) => {
      put(null)
      onPick(row.agentId)
    },
    [onPick, put],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      const current = held.current
      if (current === null) return

      if (key.name === 'escape') {
        handleDismiss()
        return
      }

      if (key.name === 'up' || key.name === 'down') {
        put(moveAgentSelection({ state: current, delta: key.name === 'up' ? -1 : 1 }))
        return
      }

      if (key.name === 'return') {
        const row = selectedAgent(current)
        if (row !== undefined) handlePick(row)
      }
    },
    [handleDismiss, handlePick, put],
  )

  return useMemo(
    () => ({ state, handleOpen, handleDismiss, handlePick, handleKey }),
    [handleDismiss, handleKey, handleOpen, handlePick, state],
  )
}
