import type { LinkedPullRequest } from '@dltech/atlas-core'

export const THREAD_ROWS = 8

export const UNTITLED_LABEL = 'untitled'

export type ThreadListing = {
  id: string
  title?: string | undefined
  updatedAt: string
  agent?: { spawnedBy: string; type: string } | undefined
  worktree?: { path: string; branch: string } | undefined
  pullRequests?: readonly LinkedPullRequest[] | undefined
}

export type ThreadChip = { label: string; ground: string; ink: string }

export type ThreadRow = {
  threadId: string
  label: string
  titled: boolean
  updatedAt: string
  active: boolean
  worktree?: { path: string; branch: string } | undefined
  pullRequests?: readonly LinkedPullRequest[] | undefined
  chips?: readonly ThreadChip[] | undefined
}

export type ThreadsState = {
  rows: readonly ThreadRow[]
  index: number
  query: string
  loading: boolean
  failure: string | null
  openedAt: number
}

export type ThreadsWindow = { start: number; visible: readonly ThreadRow[]; below: number }

const MINUTE_MS = 60_000

const HOUR_MS = 60 * MINUTE_MS

const DAY_MS = 24 * HOUR_MS

const WEEK_MS = 7 * DAY_MS

export function threadAge(args: { updatedAt: string; now: number }): string {
  const at = new Date(args.updatedAt).getTime()
  if (Number.isNaN(at)) return ''

  const elapsed = Math.max(0, args.now - at)
  if (elapsed < MINUTE_MS) return 'just now'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`
  if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`

  return new Date(at).toISOString().slice(0, 10)
}

/**
 * A supervised thread is Atlas's own work, not a conversation the operator started, so it is
 * reached from the sidebar of whoever spawned it rather than from this listing.
 */
export function threadRows(args: {
  threads: readonly ThreadListing[]
  activeThreadId: string
}): readonly ThreadRow[] {
  return args.threads
    .filter((thread) => thread.agent === undefined || thread.id === args.activeThreadId)
    .map((thread) => ({
      threadId: thread.id,
      label: thread.title === undefined || thread.title.length === 0 ? thread.id : thread.title,
      titled: thread.title !== undefined && thread.title.length > 0,
      updatedAt: thread.updatedAt,
      active: thread.id === args.activeThreadId,
      ...(thread.worktree === undefined ? {} : { worktree: thread.worktree }),
      ...(thread.pullRequests === undefined ? {} : { pullRequests: thread.pullRequests }),
    }))
}

export function loadingThreads(args: { now: number }): ThreadsState {
  return { rows: [], index: 0, query: '', loading: true, failure: null, openedAt: args.now }
}

const clamped = (args: { value: number; count: number }): number =>
  Math.min(Math.max(0, args.value), Math.max(0, args.count - 1))

export function matchingThreads(state: ThreadsState): readonly ThreadRow[] {
  const asked = state.query.trim().toLowerCase()
  if (asked.length === 0) return state.rows

  return state.rows.filter(
    (row) => row.label.toLowerCase().includes(asked) || row.threadId.toLowerCase().includes(asked),
  )
}

export function withThreads(args: {
  state: ThreadsState
  rows: readonly ThreadRow[]
}): ThreadsState {
  const active = args.rows.findIndex((row) => row.active)
  const next = { ...args.state, rows: args.rows, loading: false, failure: null }

  return { ...next, index: clamped({ value: active, count: matchingThreads(next).length }) }
}

/**
 * Badges land after the rows do — the listing is a local read, a pull request is a network call —
 * so they attach in a second pass keyed by thread. Rows a badge says nothing about keep their
 * identity, and the selection is untouched because the row count cannot change here.
 */
export function withChips(args: {
  state: ThreadsState
  chips: ReadonlyMap<string, readonly ThreadChip[]>
}): ThreadsState {
  if (args.chips.size === 0) return args.state

  return {
    ...args.state,
    rows: args.state.rows.map((row) => {
      const chips = args.chips.get(row.threadId)
      return chips === undefined || chips.length === 0 ? row : { ...row, chips }
    }),
  }
}

const CHIP_PAD = 2

const CHIP_GAP = 2

const chipCells = (chip: ThreadChip): number => chip.label.length + CHIP_PAD

const rowOf = (chips: readonly ThreadChip[]): number =>
  chips.reduce((total, chip, index) => total + chipCells(chip) + (index === 0 ? 0 : CHIP_GAP), 0)

const overflowCells = (count: number): number => `+${count}`.length + CHIP_PAD

/**
 * As many chips as the row can hold, then a `+N` counting the rest. The counter stands in for
 * chips the width denied, so it must fit where they could not: it is tried at every cut rather
 * than assumed.
 */
export function visibleChips(args: {
  chips: readonly ThreadChip[]
  cells: number
}): { shown: readonly ThreadChip[]; overflow: number } {
  const { chips, cells } = args
  if (rowOf(chips) <= cells) return { shown: chips, overflow: 0 }

  for (let keep = chips.length - 1; keep >= 0; keep -= 1) {
    const shown = chips.slice(0, keep)
    const gap = shown.length === 0 ? 0 : CHIP_GAP
    if (rowOf(shown) + gap + overflowCells(chips.length - keep) <= cells) {
      return { shown, overflow: chips.length - keep }
    }
  }

  return { shown: [], overflow: chips.length }
}

export function failedToList(args: { state: ThreadsState; reason: string }): ThreadsState {
  return { ...args.state, loading: false, failure: args.reason }
}

export function moveSelection(args: { state: ThreadsState; delta: number }): ThreadsState {
  const count = matchingThreads(args.state).length
  if (count === 0) return args.state

  return {
    ...args.state,
    index: clamped({ value: args.state.index + Math.trunc(args.delta), count }),
  }
}

export function typeInto(args: { state: ThreadsState; text: string }): ThreadsState {
  return { ...args.state, query: `${args.state.query}${args.text}`, index: 0, failure: null }
}

export function backspace(state: ThreadsState): ThreadsState {
  return { ...state, query: state.query.slice(0, -1), index: 0, failure: null }
}

export const selectedThread = (state: ThreadsState): ThreadRow | undefined =>
  matchingThreads(state)[state.index]

export function threadsWindow(args: { state: ThreadsState; rows: number }): ThreadsWindow {
  const rows = Math.max(1, Math.trunc(args.rows))
  const matches = matchingThreads(args.state)
  if (matches.length <= rows) return { start: 0, visible: matches, below: 0 }

  const start = Math.min(Math.max(0, args.state.index - rows + 1), matches.length - rows)
  return {
    start,
    visible: matches.slice(start, start + rows),
    below: matches.length - start - rows,
  }
}
