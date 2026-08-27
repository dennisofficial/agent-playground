import { rewindTarget, type BranchId, type ERewindRefusal, type EventLogPort } from '@dltech/atlas-core'

import type { BranchStorePort } from './branch-store'

export type RewindResult =
  | { ok: true; discarded: number }
  | { ok: false; refusal: ERewindRefusal; reason: string }

export async function rewindBranch({
  log,
  branches,
  branchId,
  toSeq,
}: {
  log: EventLogPort
  branches: BranchStorePort
  branchId: BranchId
  toSeq: number
}): Promise<RewindResult> {
  const events = await log.read({ branchId })
  const owned = await log.readOwn({ branchId })
  const firstOwned = owned[0]
  const floorSeq = firstOwned === undefined ? await log.head({ branchId }) : firstOwned.seq - 1

  const target = rewindTarget({ events, toSeq, floorSeq })
  if (!target.allowed) return { ok: false, refusal: target.refusal, reason: target.reason }

  await branches.rewind({ branchId, toSeq })
  return { ok: true, discarded: owned.filter((event) => event.seq > toSeq).length }
}
