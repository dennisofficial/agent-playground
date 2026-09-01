import {
  EOccupancy,
  EWorktreeLockHolder,
  parseWorktreeLockToken,
  worktreeLockHolder,
  type WorktreeLockIdentity,
} from '@dltech/atlas-core'

import type { Worktree } from '../workspace/worktrees-parse'

export type Seat = { occupancy: EOccupancy; heldBy: number | undefined }

export type SeatReaders = {
  ownIdentity: () => Promise<WorktreeLockIdentity>
  holderIsLive: (identity: WorktreeLockIdentity) => Promise<boolean>
}

const lockIsLive = async (args: {
  reason: string | undefined
  holderIsLive: SeatReaders['holderIsLive']
}): Promise<boolean> => {
  if (args.reason === undefined) return false

  const holder = parseWorktreeLockToken(args.reason)
  return holder === undefined ? false : await args.holderIsLive(holder)
}

export async function seatOf(
  args: SeatReaders & { worktree: Worktree; ourPath: string | undefined },
): Promise<Seat> {
  const { worktree } = args
  const reason = worktree.lockedReason
  const heldBy = reason === undefined ? undefined : parseWorktreeLockToken(reason)?.pid

  if (worktree.path === args.ourPath) return { occupancy: EOccupancy.Ours, heldBy }
  if (!worktree.isLocked) return { occupancy: EOccupancy.Unknown, heldBy: undefined }

  const holder = worktreeLockHolder({
    reason,
    ours: await args.ownIdentity(),
    holderIsLive: await lockIsLive({ reason, holderIsLive: args.holderIsLive }),
  })

  if (holder === EWorktreeLockHolder.Ours) return { occupancy: EOccupancy.Ours, heldBy }
  if (holder === EWorktreeLockHolder.LiveOther) return { occupancy: EOccupancy.LiveOther, heldBy }

  return { occupancy: EOccupancy.Unknown, heldBy }
}
