import { describe, expect, it } from 'bun:test'

import type { Event } from '../../events/envelope'
import { EWorktreeExit } from '../../events/body'
import { activeWorktreeOf, projectDirectoryOf } from '../worktree'

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

const exited = (args: { path: string; action: EWorktreeExit }) =>
  event({ type: 'worktree-exited', path: args.path, action: args.action })

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
})
