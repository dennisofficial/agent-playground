import { describe, expect, it } from 'bun:test'

import {
  backspace,
  failedToList,
  loadingThreads,
  matchingThreads,
  moveSelection,
  selectedThread,
  threadAge,
  threadRows,
  threadsWindow,
  typeInto,
  withThreads,
  type ThreadListing,
  type ThreadsState,
} from '../threads-model'

const AT = '2026-08-25T12:00:00.000Z'

const NOW = new Date(AT).getTime()

const listing = (args: { id: string; title?: string; minutesAgo?: number }): ThreadListing => ({
  id: args.id,
  updatedAt: new Date(NOW - (args.minutesAgo ?? 0) * 60_000).toISOString(),
  ...(args.title === undefined ? {} : { title: args.title }),
})

const THREE: readonly ThreadListing[] = [
  listing({ id: 'thread-a', title: 'the auth overlay', minutesAgo: 2 }),
  listing({ id: 'thread-b', minutesAgo: 90 }),
  listing({ id: 'thread-c', title: 'shell teardown', minutesAgo: 4000 }),
]

const opened = (args: { threads?: readonly ThreadListing[]; active?: string } = {}): ThreadsState =>
  withThreads({
    state: loadingThreads({ now: NOW }),
    rows: threadRows({
      threads: args.threads ?? THREE,
      activeThreadId: args.active ?? 'thread-b',
    }),
  })

describe('the rows a listing becomes', () => {
  it('shows a titled thread by its title and an untitled one by its id', () => {
    const rows = threadRows({ threads: THREE, activeThreadId: 'thread-a' })

    expect(rows[0]?.label).toBe('the auth overlay')
    expect(rows[0]?.titled).toBe(true)
    expect(rows[1]?.label).toBe('thread-b')
    expect(rows[1]?.titled).toBe(false)
  })

  it('marks the thread already on screen', () => {
    const rows = threadRows({ threads: THREE, activeThreadId: 'thread-c' })

    expect(rows.map((row) => row.active)).toEqual([false, false, true])
  })

  it('treats an empty title as no title', () => {
    const rows = threadRows({ threads: [listing({ id: 'bare', title: '' })], activeThreadId: '' })

    expect(rows[0]?.label).toBe('bare')
    expect(rows[0]?.titled).toBe(false)
  })
})

describe('opening the picker', () => {
  it('starts on the thread already open, so enter changes nothing', () => {
    expect(selectedThread(opened())?.threadId).toBe('thread-b')
  })

  it('starts at the top when the open thread is not in the list', () => {
    expect(selectedThread(opened({ active: 'elsewhere' }))?.threadId).toBe('thread-a')
  })

  it('stamps the moment it opened, so ages do not read off a turn clock that stops when idle', () => {
    const state = withThreads({
      state: loadingThreads({ now: NOW }),
      rows: threadRows({ threads: THREE, activeThreadId: 'thread-b' }),
    })

    expect(state.openedAt).toBe(NOW)
  })

  it('is loading until the rows land', () => {
    expect(loadingThreads({ now: NOW }).loading).toBe(true)
    expect(opened().loading).toBe(false)
  })
})

describe('moving through the list', () => {
  it('walks down and back up', () => {
    const moved = moveSelection({ state: opened(), delta: 1 })

    expect(selectedThread(moved)?.threadId).toBe('thread-c')
    expect(selectedThread(moveSelection({ state: moved, delta: -1 }))?.threadId).toBe('thread-b')
  })

  it('stops at each end rather than wrapping', () => {
    const top = moveSelection({ state: opened({ active: 'thread-a' }), delta: -5 })
    const bottom = moveSelection({ state: opened(), delta: 5 })

    expect(selectedThread(top)?.threadId).toBe('thread-a')
    expect(selectedThread(bottom)?.threadId).toBe('thread-c')
  })

  it('does nothing when nothing matches', () => {
    const empty = typeInto({ state: opened(), text: 'zzz' })

    expect(moveSelection({ state: empty, delta: 1 })).toBe(empty)
    expect(selectedThread(empty)).toBeUndefined()
  })
})

describe('filtering as you type', () => {
  it('matches on the title', () => {
    const typed = typeInto({ state: opened(), text: 'auth' })

    expect(matchingThreads(typed).map((row) => row.threadId)).toEqual(['thread-a'])
  })

  it('matches on the id, so an untitled thread is still reachable', () => {
    const typed = typeInto({ state: opened(), text: 'thread-b' })

    expect(matchingThreads(typed).map((row) => row.threadId)).toEqual(['thread-b'])
  })

  it('ignores case', () => {
    expect(matchingThreads(typeInto({ state: opened(), text: 'AUTH' })).length).toBe(1)
  })

  it('returns the selection to the top, so the highlight is never off the filtered list', () => {
    const moved = moveSelection({ state: opened(), delta: 1 })
    const typed = typeInto({ state: moved, text: 'shell' })

    expect(typed.index).toBe(0)
    expect(selectedThread(typed)?.threadId).toBe('thread-c')
  })

  it('restores the full list as the query is deleted', () => {
    const typed = typeInto({ state: opened(), text: 'a' })

    expect(matchingThreads(backspace(typed)).length).toBe(3)
  })
})

describe('the visible window', () => {
  const many = Array.from({ length: 20 }, (_, at) =>
    listing({ id: `thread-${at}`, minutesAgo: at }),
  )

  it('shows every row when they all fit', () => {
    const window = threadsWindow({ state: opened(), rows: 8 })

    expect(window.visible.length).toBe(3)
    expect(window.below).toBe(0)
  })

  it('scrolls to keep the selection in view and counts what is below', () => {
    const state = moveSelection({
      state: opened({ threads: many, active: 'thread-0' }),
      delta: 10,
    })
    const window = threadsWindow({ state, rows: 8 })

    expect(window.visible.map((row) => row.threadId)).toContain('thread-10')
    expect(window.start).toBe(3)
    expect(window.below).toBe(9)
  })
})

describe('a listing that failed', () => {
  it('keeps the reason and stops loading', () => {
    const failed = failedToList({
      state: loadingThreads({ now: NOW }),
      reason: 'the database is locked',
    })

    expect(failed.loading).toBe(false)
    expect(failed.failure).toBe('the database is locked')
  })
})

describe('how long ago a thread was touched', () => {
  it('reads in the largest unit that still says something', () => {
    expect(threadAge({ updatedAt: new Date(NOW - 30_000).toISOString(), now: NOW })).toBe(
      'just now',
    )
    expect(threadAge({ updatedAt: new Date(NOW - 5 * 60_000).toISOString(), now: NOW })).toBe(
      '5m ago',
    )
    expect(threadAge({ updatedAt: new Date(NOW - 3 * 3_600_000).toISOString(), now: NOW })).toBe(
      '3h ago',
    )
    expect(threadAge({ updatedAt: new Date(NOW - 2 * 86_400_000).toISOString(), now: NOW })).toBe(
      '2d ago',
    )
  })

  it('falls back to a date once a week has passed', () => {
    expect(threadAge({ updatedAt: '2026-01-04T09:00:00.000Z', now: NOW })).toBe('2026-01-04')
  })

  it('says nothing for a timestamp it cannot read', () => {
    expect(threadAge({ updatedAt: 'not a date', now: NOW })).toBe('')
  })
})
