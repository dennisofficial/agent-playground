import type { KeyEvent } from '@opentui/core'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ThreadId } from '@dltech/atlas-core'
import { EKilledBy, type ShellSnapshot } from '@dltech/atlas-harness'

import { DEFAULT_CREW_CAP } from '../store/crew-fold'
import { DEFAULT_CREW_GRACE_MS } from '../store/crew-retirement'
import { NO_VISITS, recordDeparture, type CrewVisits } from '../store/crew-visits'
import { foldShells, shellGraceIsRunning } from '../store/shell-retirement'
import { useTickingNow } from './use-ticking-now'
import type { SidebarCrewFold } from '../store/subagent-row'
import { useOutputScroll, type OutputScroll } from '../ui/hooks/use-output-scroll'
import {
  moveShellSelection,
  openShells,
  outputScrollCommand,
  runningCount,
  selectShell,
  selectedShell,
  type ShellsState,
} from '../ui/shells-model'
import type { AtlasApp } from './compose'

const POLL_MS = 500

/**
 * The scrollback a reader can walk back through, well short of the 400k the registry retains: every
 * poll that finds new output re-wraps this whole tail.
 */
const PEEKED_CHARACTERS = 64_000

const KILL_KEYS = new Set(['k', 'x'])

export type ShellsControl = {
  shells: readonly ShellSnapshot[]
  folded: readonly ShellSnapshot[]
  fold: SidebarCrewFold
  everywhere: readonly ShellSnapshot[]
  running: number
  state: ShellsState | null
  selected: ShellSnapshot | undefined
  output: string
  scroll: OutputScroll
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

type ShellLists = { own: readonly ShellSnapshot[]; everywhere: readonly ShellSnapshot[] }

const keptIfSame = (
  current: readonly ShellSnapshot[],
  latest: readonly ShellSnapshot[],
): readonly ShellSnapshot[] => (sameShells(current, latest) ? current : latest)

/**
 * A background shell is live process state rather than an event in the log, so nothing publishes a
 * delta when it prints. Polling is the honest mechanism; the snapshot comparison is what keeps it
 * from re-rendering the tree twice a second while a shell sits idle.
 *
 * Both lists come off one timer. They are two views of the same registry, so polling them apart
 * would buy nothing and let the exit guard and the sidebar disagree for up to an interval.
 */
function useShellSnapshots(read: () => ShellLists): ShellLists {
  const [lists, setLists] = useState<ShellLists>(read)

  /**
   * Re-reading on the reader itself, not only on the interval: switching conversations changes who
   * owns the list, and waiting out a poll would leave the other conversation's shells on screen.
   */
  useEffect(() => {
    const poll = (): void =>
      setLists((current) => {
        const latest = read()
        const own = keptIfSame(current.own, latest.own)
        const everywhere = keptIfSame(current.everywhere, latest.everywhere)

        return own === current.own && everywhere === current.everywhere
          ? current
          : { own, everywhere }
      })

    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [read])

  return lists
}

function useShellVisits(viewing: string | null): CrewVisits {
  const [visits, setVisits] = useState<CrewVisits>(NO_VISITS)

  useEffect(() => {
    if (viewing === null) return

    return () => {
      setVisits((held) =>
        recordDeparture({ visits: held, leaving: viewing, at: new Date().toISOString() }),
      )
    }
  }, [viewing])

  return visits
}

/**
 * A settled shell prints nothing more, so the poll finds the same snapshots and holds the render
 * still — the one thing a grace window cannot survive. The tick runs only while some shell is
 * inside its window, and the reading it answers with is the wall clock rather than the ticked one.
 */
/**
 * The scoped list is what a conversation may see and act on; the unscoped one exists for the exit
 * guard alone, because quitting kills every shell in the process whoever started it.
 */
export function useShells({ app, threadId }: { app: AtlasApp; threadId: ThreadId }): ShellsControl {
  const read = useCallback(
    (): ShellLists => ({
      own: app.shells.list({ threadId }),
      everywhere: app.shells.listEverywhere(),
    }),
    [app, threadId],
  )
  const { own: shells, everywhere } = useShellSnapshots(read)
  const [state, setState] = useState<ShellsState | null>(null)

  const selected = state === null ? undefined : selectedShell({ state, shells })

  const viewing = selected?.shellId ?? null
  const visits = useShellVisits(viewing)
  const now = useTickingNow(
    shellGraceIsRunning({
      shells,
      visits,
      viewing,
      now: Date.now(),
      graceMs: DEFAULT_CREW_GRACE_MS,
    }),
  )

  const folded = useMemo(
    () =>
      foldShells({
        shells,
        visits,
        viewing,
        now,
        graceMs: DEFAULT_CREW_GRACE_MS,
        cap: DEFAULT_CREW_CAP,
      }),
    [now, shells, viewing, visits],
  )

  const [output, setOutput] = useState('')
  const openId = selected?.shellId
  const printed = selected?.totalCharacters
  const scroll = useOutputScroll({ resetKey: openId })

  useEffect(() => {
    if (openId === undefined) {
      setOutput('')
      return
    }
    setOutput(app.shells.peek({ shellId: openId, characters: PEEKED_CHARACTERS, threadId }) ?? '')
  }, [app, openId, printed, threadId])

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
      app.shells.kill({ shellId, by: EKilledBy.User, threadId })
      setState((current) => (current === null ? null : { ...current }))
    },
    [app, threadId],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (state === null) return

      if (key.name === 'escape' || key.name === 'q') {
        handleDismiss()
        return
      }

      const scrolling = outputScrollCommand(key)
      if (scrolling !== null) {
        scroll.handleCommand(scrolling)
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
    [handleDismiss, handleKill, scroll, selected, shells.length, state],
  )

  return useMemo(
    () => ({
      shells,
      folded: folded.shown,
      fold: { hidden: folded.hidden, hiddenFailed: folded.hiddenFailed },
      everywhere,
      running: runningCount(everywhere),
      state,
      selected,
      output,
      scroll,
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
      everywhere,
      folded,
      output,
      scroll,
      selected,
      shells,
      state,
    ],
  )
}
