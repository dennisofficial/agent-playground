import {
  EWorktreeLockHolder,
  parseWorktreeLockToken,
  worktreeLockHolder,
  worktreeLockToken,
  type WorktreeLockIdentity,
} from '@dltech/atlas-core'

import { holderIsLive, ownIdentity } from './process-identity'
import { listWorktrees, lockWorktree, unlockWorktree } from './worktrees'

export enum EWorktreeClaim {
  Owned = 'owned',
  Reclaimed = 'reclaimed',
  Guest = 'guest',
  Held = 'held',
}

export type WorktreeClaim = {
  claim: EWorktreeClaim
  note: string | undefined
  heldBy: number | undefined
}

const lockedReasonOf = async ({
  cwd,
  path,
}: {
  cwd: string
  path: string
}): Promise<{ known: boolean; reason: string | undefined }> => {
  const listing = await listWorktrees({ cwd })
  if (!listing.ok) return { known: false, reason: undefined }

  const found = listing.worktrees.find((worktree) => worktree.path === path)
  if (found === undefined) return { known: false, reason: undefined }
  if (!found.isLocked) return { known: true, reason: undefined }

  return { known: true, reason: found.lockedReason ?? '' }
}

const liveness = async (reason: string | undefined): Promise<boolean> => {
  if (reason === undefined) return false

  const holder = parseWorktreeLockToken(reason)
  return holder === undefined ? false : await holderIsLive(holder)
}

export async function claimWorktree(args: {
  cwd: string
  path: string
  label: string
}): Promise<WorktreeClaim> {
  const ours = await ownIdentity()
  const reason = worktreeLockToken({ label: args.label, identity: ours })

  const taken = await lockWorktree({ cwd: args.cwd, path: args.path, reason })
  if (taken.ok) return { claim: EWorktreeClaim.Owned, note: undefined, heldBy: undefined }

  const existing = await lockedReasonOf({ cwd: args.cwd, path: args.path })
  if (!existing.known) {
    return {
      claim: EWorktreeClaim.Guest,
      note: `Atlas could not lock the worktree and could not read the worktree registry to see who holds it (${taken.message}), so this session is working in it as a guest.`,
      heldBy: undefined,
    }
  }

  const holder = worktreeLockHolder({
    reason: existing.reason,
    ours,
    holderIsLive: await liveness(existing.reason),
  })

  if (holder === EWorktreeLockHolder.Ours) {
    return { claim: EWorktreeClaim.Owned, note: undefined, heldBy: ours.pid }
  }

  if (holder === EWorktreeLockHolder.LiveOther) {
    const other =
      existing.reason === undefined ? undefined : parseWorktreeLockToken(existing.reason)
    return {
      claim: EWorktreeClaim.Held,
      note: `another Atlas session is working in it (${existing.reason ?? 'no reason recorded'})`,
      heldBy: other?.pid,
    }
  }

  if (holder === EWorktreeLockHolder.Stale) {
    const cleared = await unlockWorktree({ cwd: args.cwd, path: args.path })
    if (cleared.ok) {
      const retaken = await lockWorktree({ cwd: args.cwd, path: args.path, reason })
      if (retaken.ok) {
        return {
          claim: EWorktreeClaim.Reclaimed,
          note: 'It was left locked by an Atlas session that is no longer running, so that stale lock was cleared.',
          heldBy: undefined,
        }
      }
    }
    return {
      claim: EWorktreeClaim.Guest,
      note: 'It carries a stale Atlas lock that could not be cleared, so this session is working in it as a guest.',
      heldBy: undefined,
    }
  }

  return {
    claim: EWorktreeClaim.Guest,
    note: `It is locked outside Atlas (${existing.reason === undefined || existing.reason.length === 0 ? 'no reason given' : existing.reason}), so that lock was left alone and this session is working in it as a guest.`,
    heldBy: undefined,
  }
}

export async function releaseWorktree(args: { cwd: string; path: string }): Promise<boolean> {
  const existing = await lockedReasonOf({ cwd: args.cwd, path: args.path })
  if (!existing.known || existing.reason === undefined) return false

  const ours = await ownIdentity()
  const holder = worktreeLockHolder({ reason: existing.reason, ours, holderIsLive: true })
  if (holder !== EWorktreeLockHolder.Ours) return false

  return (await unlockWorktree({ cwd: args.cwd, path: args.path })).ok
}
