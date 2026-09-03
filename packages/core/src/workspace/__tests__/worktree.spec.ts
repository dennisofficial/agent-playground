import { describe, expect, it } from 'bun:test'

import type { Event } from '../../events/envelope'
import { EWorktreeExit } from '../../events/body'
import {
  activeWorktreeAfter,
  activeWorktreeOf,
  homeDirectoryAfter,
  homeDirectoryOf,
  projectDirectoryOf,
} from '../worktree'

const LAUNCH = '/Users/dev/atlas'
const TREE = `${LAUNCH}/.atlas/worktrees/eng-327-api-eslint`
const OTHER = `${LAUNCH}/.atlas/worktrees/eng-401-store-spend`

let nextSeq = 0

const event = (body: Record<string, unknown>): Event => {
  nextSeq += 1
  return {
    id: `evt_${nextSeq}`,
    seq: nextSeq,
    threadId: 'br_1',
    runId: 'run_1',
    depth: 0,
    at: '2026-08-31T12:00:00.000Z',
    ...body,
  } as Event
}

const said = (text: string) => event({ type: 'user-said', text })

const entered = (args: { path: string; branch: string }) =>
  event({ type: 'worktree-entered', path: args.path, branch: args.branch, base: 'origin/main' })

const exited = (args: { path: string; action: EWorktreeExit; returnTo?: string }) =>
  event({
    type: 'worktree-exited',
    path: args.path,
    action: args.action,
    ...(args.returnTo === undefined ? {} : { returnTo: args.returnTo }),
  })

describe('which worktree the session is in', () => {
  it('is in none until one is entered', () => {
    expect(activeWorktreeOf([said('hello'), said('again')])).toBeUndefined()
  })

  it('is the worktree that was entered', () => {
    const events = [said('hello'), entered({ path: TREE, branch: 'dennis/eng-327' })]

    expect(activeWorktreeOf(events)).toEqual({
      path: TREE,
      branch: 'dennis/eng-327',
      base: 'origin/main',
      adopted: false,
    })
  })

  it('is in none again once that worktree is exited', () => {
    const events = [
      entered({ path: TREE, branch: 'dennis/eng-327' }),
      exited({ path: TREE, action: EWorktreeExit.Keep }),
      said('back at the repo'),
    ]

    expect(activeWorktreeOf(events)).toBeUndefined()
  })

  it('takes the latest of several entries', () => {
    const events = [
      entered({ path: TREE, branch: 'dennis/eng-327' }),
      exited({ path: TREE, action: EWorktreeExit.Keep }),
      entered({ path: OTHER, branch: 'dennis/eng-401' }),
    ]

    expect(activeWorktreeOf(events)?.path).toBe(OTHER)
  })

  it('switches directly from one worktree to another without an exit between', () => {
    const events = [
      entered({ path: TREE, branch: 'dennis/eng-327' }),
      entered({ path: OTHER, branch: 'dennis/eng-401' }),
    ]

    expect(activeWorktreeOf(events)?.branch).toBe('dennis/eng-401')
  })
})

describe('where the project is', () => {
  it('is the launch directory until a worktree is entered', () => {
    expect(projectDirectoryOf({ events: [said('hello')], launchDirectory: LAUNCH })).toBe(LAUNCH)
  })

  it('is the worktree while one is entered', () => {
    const events = [entered({ path: TREE, branch: 'dennis/eng-327' })]

    expect(projectDirectoryOf({ events, launchDirectory: LAUNCH })).toBe(TREE)
  })

  it('returns to the launch directory once the worktree is exited', () => {
    const events = [
      entered({ path: TREE, branch: 'dennis/eng-327' }),
      exited({ path: TREE, action: EWorktreeExit.Remove }),
    ]

    expect(projectDirectoryOf({ events, launchDirectory: LAUNCH })).toBe(LAUNCH)
  })

  it('lands on the returnTo an exit recorded, even when that is not the launch directory', () => {
    const events = [exited({ path: TREE, action: EWorktreeExit.Keep, returnTo: LAUNCH })]

    expect(projectDirectoryOf({ events, launchDirectory: TREE })).toBe(LAUNCH)
  })

  it('keeps the re-homed directory as home across later enter and exit cycles', () => {
    const events = [
      exited({ path: TREE, action: EWorktreeExit.Keep, returnTo: LAUNCH }),
      entered({ path: OTHER, branch: 'dennis/eng-401' }),
      exited({ path: OTHER, action: EWorktreeExit.Keep }),
    ]

    expect(projectDirectoryOf({ events, launchDirectory: TREE })).toBe(LAUNCH)
  })

  it('is the worktree entered after a re-home, not the home itself', () => {
    const events = [
      exited({ path: TREE, action: EWorktreeExit.Keep, returnTo: LAUNCH }),
      entered({ path: OTHER, branch: 'dennis/eng-401' }),
    ]

    expect(projectDirectoryOf({ events, launchDirectory: TREE })).toBe(OTHER)
  })
})

describe('the home directory', () => {
  it('is the launch directory while no exit has recorded a returnTo', () => {
    const events = [entered({ path: TREE, branch: 'dennis/eng-327' })]

    expect(homeDirectoryOf({ events, launchDirectory: LAUNCH })).toBe(LAUNCH)
  })

  it('follows the latest returnTo in the log', () => {
    const events = [
      exited({ path: TREE, action: EWorktreeExit.Keep, returnTo: LAUNCH }),
      exited({ path: OTHER, action: EWorktreeExit.Keep, returnTo: TREE }),
    ]

    expect(homeDirectoryOf({ events, launchDirectory: OTHER })).toBe(TREE)
  })

  it('folds unwritten drafts the same way', () => {
    expect(homeDirectoryAfter({ drafts: [{ type: 'user-said', text: 'hi' }], home: LAUNCH })).toBe(LAUNCH)

    const moved = homeDirectoryAfter({
      drafts: [{ type: 'worktree-exited', path: TREE, action: EWorktreeExit.Keep, returnTo: LAUNCH }],
      home: TREE,
    })
    expect(moved).toBe(LAUNCH)
  })
})

describe('folding drafts that have not been written yet', () => {
  it('keeps the worktree in hand when no draft moves it', () => {
    const active = { path: TREE, branch: 'dennis/eng-327', base: 'origin/main', adopted: false }

    expect(activeWorktreeAfter({ drafts: [{ type: 'user-said', text: 'hi' }], active })).toEqual(active)
  })

  it('takes the last entry in the batch, carrying whether it was adopted', () => {
    const folded = activeWorktreeAfter({
      drafts: [
        { type: 'worktree-entered', path: TREE, branch: 'dennis/eng-327', base: 'origin/main' },
        { type: 'worktree-entered', path: OTHER, branch: 'by-hand', adopted: true },
      ],
      active: undefined,
    })

    expect(folded).toEqual({ path: OTHER, branch: 'by-hand', base: undefined, adopted: true })
  })

  it('is in none again once a draft exits', () => {
    const active = { path: TREE, branch: 'dennis/eng-327', base: 'origin/main', adopted: false }
    const drafts = [{ type: 'worktree-exited' as const, path: TREE, action: EWorktreeExit.Keep }]

    expect(activeWorktreeAfter({ drafts, active })).toBeUndefined()
  })
})
