import {
  ECompactionAnchor,
  planCompaction,
  type Event,
  type EventLogPort,
  type ThreadId,
} from '@dltech/atlas-core'
import { compactThread, type ThreadStorePort } from '@dltech/atlas-harness'

export enum ECompaction {
  Compacted = 'compacted',
  Refused = 'refused',
  Nothing = 'nothing',
}

export type Compaction =
  | { type: ECompaction.Compacted; replaced: number; fromSeq: number; throughSeq: number }
  | { type: ECompaction.Refused; reason: string }
  | { type: ECompaction.Nothing }

export type Summariser = (args: {
  events: readonly Event[]
  fromSeq: number
  throughSeq: number
  signal?: AbortSignal | undefined
}) => Promise<string | null>

export enum ECompactScope {
  Recent = 'recent',
  Everything = 'everything',
}

/**
 * An explicit request is not the automatic trigger and must not inherit its recency budget: keeping
 * 30% of the window in reserve means a request on any ordinary conversation would find no candidate
 * and quietly do nothing. Asked directly, compaction keeps the operator's most recent turn and takes
 * everything before it.
 */
const KEEP_THE_LAST_TURN = 0

async function watermarkFor({
  log,
  threadId,
  scope,
}: {
  log: EventLogPort
  threadId: ThreadId
  scope: ECompactScope
}): Promise<number | undefined> {
  const events = await log.read({ threadId })
  if (scope === ECompactScope.Everything) return events.at(-1)?.seq

  return planCompaction({ events, keepRecentTokens: KEEP_THE_LAST_TURN })?.throughSeq
}

export async function compactTurn(args: {
  log: EventLogPort
  threads: ThreadStorePort
  threadId: ThreadId
  scope?: ECompactScope | undefined
  summarise: Summariser
  signal?: AbortSignal | undefined
}): Promise<Compaction> {
  const { log, threads, threadId, summarise } = args
  const scope = args.scope ?? ECompactScope.Recent

  const throughSeq = await watermarkFor({ log, threadId, scope })
  if (throughSeq === undefined) return { type: ECompaction.Nothing }

  return compactAt({
    log,
    threads,
    threadId,
    anchor: ECompactionAnchor.Prefix,
    seq: throughSeq,
    summarise,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  })
}

type Marking = {
  log: EventLogPort
  threads: ThreadStorePort
  threadId: ThreadId
  anchor: ECompactionAnchor
  seq: number
  summarise: Summariser
  signal?: AbortSignal | undefined
}

/**
 * Hides a range from the model and leaves the rows where they are, so the transcript still shows
 * them and a rewind can still reach past the boundary. This is what the window forcing our hand
 * looks like: nobody asked to lose anything.
 */
export const compactAt = (args: Marking): Promise<Compaction> =>
  marked({ ...args, destructive: false })

/**
 * The operator pointing at a message and pruning around it. Unlike compaction this is a deliberate
 * edit, so the rows go and the rewind floor rises behind it.
 */
export const summariseAt = (args: Marking): Promise<Compaction> =>
  marked({ ...args, destructive: true })

async function marked({
  log,
  threads,
  threadId,
  anchor,
  seq,
  summarise,
  signal,
  destructive,
}: Marking & { destructive: boolean }): Promise<Compaction> {
  const outcome = await compactThread({
    log,
    threads,
    threadId,
    anchor,
    seq,
    summarise,
    destructive,
    ...(signal === undefined ? {} : { signal }),
  })

  if (!outcome.ok) return { type: ECompaction.Refused, reason: outcome.reason }

  return {
    type: ECompaction.Compacted,
    replaced: outcome.replaced,
    fromSeq: outcome.fromSeq,
    throughSeq: outcome.throughSeq,
  }
}

export const scopeOfArgument = (argumentText: string): ECompactScope | null => {
  const asked = argumentText.trim().toLowerCase()
  if (asked === '') return ECompactScope.Recent
  if (asked === 'all') return ECompactScope.Everything
  return null
}
