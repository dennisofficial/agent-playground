import {
  modelEntry,
  planCompaction,
  type ThreadId,
  type Event,
  type EventLogPort,
} from '@dltech/atlas-core'
import { compactThread, type ThreadStorePort } from '@dltech/atlas-harness'

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
  threads: ThreadStorePort
  threadId: ThreadId
  keepRecentTokens: number
  summarise: Summariser
}): Promise<Compaction> {
  const { log, threads, threadId, keepRecentTokens, summarise } = args

  const events = await log.read({ threadId })
  const plan = planCompaction({ events, keepRecentTokens })
  if (plan === undefined) return { type: ECompaction.Nothing }

  const outcome = await compactThread({
    log,
    threads,
    threadId,
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
