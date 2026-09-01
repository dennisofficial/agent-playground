import { describe, expect, it } from 'bun:test'

import {
  EWorktreeLockHolder,
  parseWorktreeLockToken,
  worktreeLockHolder,
  worktreeLockToken,
} from '../worktree-lock'

const OURS = { pid: 4242, start: 'Mon Sep  1 11:05:33 2026' }

const tokenFor = (identity: { pid: number; start: string | undefined }) =>
  worktreeLockToken({ label: 'thread br_7', identity })

describe('the token a session writes into the worktree lock', () => {
  it('carries the pid and the start time, so a recycled pid is not mistaken for the owner', () => {
    expect(tokenFor(OURS)).toBe('atlas thread br_7 (pid 4242 start Mon Sep  1 11:05:33 2026)')
  })

  it('round-trips back to the identity that wrote it', () => {
    expect(parseWorktreeLockToken(tokenFor(OURS))).toEqual(OURS)
  })

  it('still round-trips when the start time could not be read', () => {
    expect(parseWorktreeLockToken(tokenFor({ pid: 9, start: undefined }))).toEqual({
      pid: 9,
      start: undefined,
    })
  })

  it('reads nothing out of a lock somebody else wrote', () => {
    expect(parseWorktreeLockToken('rebasing, do not touch')).toBeUndefined()
    expect(parseWorktreeLockToken('atlas thread br_7 (pid nine)')).toBeUndefined()
  })
})

describe('who is holding the lock', () => {
  const verdict = (args: { reason: string | undefined; holderIsLive: boolean }) =>
    worktreeLockHolder({ ...args, ours: OURS })

  it('is nobody when the worktree is not locked', () => {
    expect(verdict({ reason: undefined, holderIsLive: false })).toBe(EWorktreeLockHolder.Absent)
  })

  it('is us when the pid and the start time both match', () => {
    expect(verdict({ reason: tokenFor(OURS), holderIsLive: true })).toBe(EWorktreeLockHolder.Ours)
  })

  it('is another live session when its process is still running', () => {
    const reason = tokenFor({ pid: 5150, start: 'Mon Sep  1 09:00:00 2026' })

    expect(verdict({ reason, holderIsLive: true })).toBe(EWorktreeLockHolder.LiveOther)
  })

  it('is stale once that process is gone', () => {
    const reason = tokenFor({ pid: 5150, start: 'Mon Sep  1 09:00:00 2026' })

    expect(verdict({ reason, holderIsLive: false })).toBe(EWorktreeLockHolder.Stale)
  })

  it('is stale when our pid was recycled, since the start time no longer matches', () => {
    const reason = tokenFor({ pid: OURS.pid, start: 'Sun Aug 31 08:00:00 2026' })

    expect(verdict({ reason, holderIsLive: false })).toBe(EWorktreeLockHolder.Stale)
  })

  it('is foreign when a person locked it themselves, however alive they are', () => {
    expect(verdict({ reason: 'holding this for the release', holderIsLive: true })).toBe(
      EWorktreeLockHolder.Foreign,
    )
  })
})
