import type { KeyEvent } from '@opentui/core'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ShellSnapshot } from '@dltech/atlas-harness'

import {
  moveShellSelection,
  openShells,
  runningCount,
  selectShell,
  selectedShell,
  type ShellsState,
} from '../ui/shells-model'
import type { AtlasApp } from './compose'

const POLL_MS = 500

const PEEKED_CHARACTERS = 8_000

const KILL_KEYS = new Set(['k', 'x'])

export type ShellsControl = {
  shells: readonly ShellSnapshot[]
  running: number
  state: ShellsState | null
  selected: ShellSnapshot | undefined
  output: string
  handleOpen: (shellId?: string) => void
  handleDismiss: () => void
  handleSelect: (shellId: string) => void
  handleKill: (shellId: string) => void
  handleKey: (key: KeyEvent) => void
}

const sameShells = (left: readonly ShellSnapshot[], right: readonly ShellSnapshot[]): boolean => {
  if (left.length !== right.length) return false

  return left.every((shell, index) => {
    const other = right[index]
    if (other === undefined) return false
    return (
      shell.shellId === other.shellId &&
      shell.status === other.status &&
      shell.exitCode === other.exitCode &&
      shell.awaitingInput === other.awaitingInput &&
      shell.totalCharacters === other.totalCharacters
    )
  })
}

/**
 * A background shell is live process state rather than an event in the log, so nothing publishes a
 * delta when it prints. Polling is the honest mechanism; the snapshot comparison is what keeps it
 * from re-rendering the tree twice a second while a shell sits idle.
 */
function useShellSnapshots(app: AtlasApp): readonly ShellSnapshot[] {
  const [shells, setShells] = useState<readonly ShellSnapshot[]>(() => app.shells.list())

  useEffect(() => {
    const read = (): void =>
      setShells((current) => {
        const latest = app.shells.list()
        return sameShells(current, latest) ? current : latest
      })

    read()
    const timer = setInterval(read, POLL_MS)
    return () => clearInterval(timer)
  }, [app])

  return shells
}

export function useShells({ app }: { app: AtlasApp }): ShellsControl {
  const shells = useShellSnapshots(app)
  const [state, setState] = useState<ShellsState | null>(null)

  const selected = state === null ? undefined : selectedShell({ state, shells })

  const [output, setOutput] = useState('')
  const openId = selected?.shellId
  const printed = selected?.totalCharacters

  useEffect(() => {
    if (openId === undefined) {
      setOutput('')
      return
    }
    setOutput(app.shells.peek({ shellId: openId, characters: PEEKED_CHARACTERS }) ?? '')
  }, [app, openId, printed])

  const handleOpen = useCallback(
    (shellId?: string) =>
      setState(openShells({ shells, ...(shellId === undefined ? {} : { shellId }) })),
    [shells],
  )

  const handleDismiss = useCallback(() => setState(null), [])

  const handleSelect = useCallback(
    (shellId: string) => setState(selectShell({ shells, shellId })),
    [shells],
  )

  const handleKill = useCallback(
    (shellId: string) => {
      app.shells.kill({ shellId })
      setState((current) => (current === null ? null : { ...current }))
    },
    [app],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (state === null) return

      if (key.name === 'escape' || key.name === 'q') {
        handleDismiss()
        return
      }

      if (key.name === 'up' || key.name === 'down') {
        setState(
          moveShellSelection({ state, count: shells.length, delta: key.name === 'up' ? -1 : 1 }),
        )
        return
      }

      const pressed = key.sequence?.toLowerCase() ?? ''
      if (KILL_KEYS.has(pressed) && selected !== undefined) handleKill(selected.shellId)
    },
    [handleDismiss, handleKill, selected, shells.length, state],
  )

  return useMemo(
    () => ({
      shells,
      running: runningCount(shells),
      state,
      selected,
      output,
      handleOpen,
      handleDismiss,
      handleSelect,
      handleKill,
      handleKey,
    }),
    [
      handleDismiss,
      handleKey,
      handleKill,
      handleOpen,
      handleSelect,
      output,
      selected,
      shells,
      state,
    ],
  )
}
