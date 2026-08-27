import {
  compactionTarget,
  type ThreadId,
  type ECompactionRefusal,
  type Event,
  type EventLogPort,
} from '@dltech/atlas-core'

import type { ThreadStorePort } from './thread-store'

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

const NO_SUMMARY = 'the summariser returned nothing, so the thread was left as it was'

export async function compactThread({
  log,
  threads,
  threadId,
  throughSeq,
  summarise,
}: {
  log: EventLogPort
  threads: ThreadStorePort
  threadId: ThreadId
  throughSeq: number
  summarise: Summarise
}): Promise<CompactionOutcome> {
  const events = await log.read({ threadId })

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

  const replaced = await threads.compact({ threadId, throughSeq, summary })

  return { ok: true, throughSeq, summary, replaced }
}
