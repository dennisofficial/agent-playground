import {
  compactionTarget,
  ECompactionAnchor,
  suffixCompactionTarget,
  type CompactionTarget,
  type ECompactionRefusal,
  type Event,
  type EventLogPort,
  type ThreadId,
} from '@dltech/atlas-core'

import type { ThreadStorePort } from './thread-store'

export enum ECompactionFailure {
  Refused = 'refused',
  NoSummary = 'no-summary',
}

export type CompactionOutcome =
  | { ok: true; anchor: ECompactionAnchor; fromSeq: number; throughSeq: number; replaced: number; summary: string }
  | { ok: false; failure: ECompactionFailure; reason: string; refusal?: ECompactionRefusal }

export type Summarise = (args: {
  events: readonly Event[]
  fromSeq: number
  throughSeq: number
  signal?: AbortSignal | undefined
}) => Promise<string | null>

const NO_SUMMARY = 'the summariser returned nothing, so the thread was left as it was'

type Range = { fromSeq: number; throughSeq: number }

function rangeFor({
  events,
  anchor,
  seq,
}: {
  events: readonly Event[]
  anchor: ECompactionAnchor
  seq: number
}): Range {
  const firstSeq = events[0]?.seq ?? seq
  const lastSeq = events.at(-1)?.seq ?? seq

  return anchor === ECompactionAnchor.Prefix
    ? { fromSeq: firstSeq, throughSeq: seq }
    : { fromSeq: seq, throughSeq: lastSeq }
}

const guardFor = ({
  events,
  anchor,
  seq,
}: {
  events: readonly Event[]
  anchor: ECompactionAnchor
  seq: number
}): CompactionTarget =>
  anchor === ECompactionAnchor.Prefix
    ? compactionTarget({ events, throughSeq: seq })
    : suffixCompactionTarget({ events, fromSeq: seq })

export async function compactThread(args: {
  log: EventLogPort
  threads: ThreadStorePort
  threadId: ThreadId
  anchor: ECompactionAnchor
  seq: number
  summarise: Summarise
  destructive?: boolean | undefined
  signal?: AbortSignal | undefined
}): Promise<CompactionOutcome> {
  const { log, threads, threadId, anchor, seq, summarise, signal } = args
  const events = await log.read({ threadId })

  const target = guardFor({ events, anchor, seq })
  if (!target.allowed) {
    return {
      ok: false,
      failure: ECompactionFailure.Refused,
      reason: target.reason,
      refusal: target.refusal,
    }
  }

  const range = rangeFor({ events, anchor, seq })

  const summary = await summarise({ events, ...range, ...(signal === undefined ? {} : { signal }) })
  if (summary === null) {
    return { ok: false, failure: ECompactionFailure.NoSummary, reason: NO_SUMMARY }
  }

  const replaced = args.destructive
    ? await threads.summarise({ threadId, anchor, ...range, summary })
    : await threads.compact({ threadId, anchor, ...range, summary })

  return { ok: true, anchor, ...range, replaced, summary }
}
