import {
  forkTarget,
  type BranchId,
  type EForkMode,
  type EForkRefusal,
  type EventLogPort,
} from '@dltech/atlas-core'

import type { BranchStorePort, BranchSummary } from './branch-store'

export type ForkResult =
  | { ok: true; branch: BranchSummary; inherited: number }
  | { ok: false; refusal: EForkRefusal; reason: string }

export async function forkConversation({
  log,
  branches,
  branchId,
  seq,
  mode,
  title,
}: {
  log: EventLogPort
  branches: BranchStorePort
  branchId: BranchId
  seq: number
  mode: EForkMode
  title?: string | undefined
}): Promise<ForkResult> {
  const events = await log.read({ branchId })

  const target = forkTarget({ events, seq, mode })
  if (!target.allowed) return { ok: false, refusal: target.refusal, reason: target.reason }

  const branch = await branches.fork({
    from: branchId,
    seq,
    mode,
    ...(title === undefined ? {} : { title }),
  })

  return { ok: true, branch, inherited: events.filter((event) => event.seq <= seq).length }
}
