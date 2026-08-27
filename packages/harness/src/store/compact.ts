import {
  compactionTarget,
  type BranchId,
  type ECompactionRefusal,
  type Event,
  type EventLogPort,
} from '@dltech/atlas-core'

import type { BranchStorePort } from './branch-store'

export enum ECompactionFailure {
  Refused = 'refused',
  NoSummary = 'no-summary',
}

export type CompactionOutcome =
  | { ok: true; throughSeq: number; replaced: number; summary: string }
  | { ok: false; failure: ECompactionFailure; reason: string; refusal?: ECompactionRefusal }

export type Summarise = (args: {
  events: readonly Event[]
  throughSeq: number
}) => Promise<string | null>

const NO_SUMMARY = 'the summariser returned nothing, so the branch was left as it was'

export async function compactBranch({
  log,
  branches,
  branchId,
  throughSeq,
  summarise,
}: {
  log: EventLogPort
  branches: BranchStorePort
  branchId: BranchId
  throughSeq: number
  summarise: Summarise
}): Promise<CompactionOutcome> {
  const events = await log.read({ branchId })

  const target = compactionTarget({ events, throughSeq })
  if (!target.allowed) {
    return {
      ok: false,
      failure: ECompactionFailure.Refused,
      reason: target.reason,
      refusal: target.refusal,
    }
  }

  const summary = await summarise({ events, throughSeq })
  if (summary === null) {
    return { ok: false, failure: ECompactionFailure.NoSummary, reason: NO_SUMMARY }
  }

  const replaced = await branches.compact({ branchId, throughSeq, summary })

  return { ok: true, throughSeq, summary, replaced }
}
