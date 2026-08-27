import {
  modelEntry,
  planCompaction,
  type BranchId,
  type Event,
  type EventLogPort,
} from '@dltech/atlas-core'
import { compactBranch, type BranchStorePort } from '@dltech/atlas-harness'

export enum ECompaction {
  Compacted = 'compacted',
  Refused = 'refused',
  Nothing = 'nothing',
}

export type Compaction =
  | { type: ECompaction.Compacted; replaced: number; throughSeq: number }
  | { type: ECompaction.Refused; reason: string }
  | { type: ECompaction.Nothing }

export type Summariser = (args: {
  events: readonly Event[]
  throughSeq: number
}) => Promise<string | null>

export async function compactTurn(args: {
  log: EventLogPort
  branches: BranchStorePort
  branchId: BranchId
  keepRecentTokens: number
  summarise: Summariser
}): Promise<Compaction> {
  const { log, branches, branchId, keepRecentTokens, summarise } = args

  const events = await log.read({ branchId })
  const plan = planCompaction({ events, keepRecentTokens })
  if (plan === undefined) return { type: ECompaction.Nothing }

  const outcome = await compactBranch({
    log,
    branches,
    branchId,
    throughSeq: plan.throughSeq,
    summarise,
  })

  if (!outcome.ok) return { type: ECompaction.Refused, reason: outcome.reason }

  return { type: ECompaction.Compacted, replaced: outcome.replaced, throughSeq: outcome.throughSeq }
}

const FALLBACK_CONTEXT_WINDOW = 200_000

export const COMPACTION_RECENCY_FRACTION = 0.3

export function recencyBudgetFor(modelId: string): number {
  const window = modelEntry(modelId)?.contextWindow ?? FALLBACK_CONTEXT_WINDOW
  return Math.round(window * COMPACTION_RECENCY_FRACTION)
}
