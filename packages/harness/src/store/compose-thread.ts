import { EForkMode, toThreadId, type ThreadId } from '@dltech/atlas-core'

import type { Prisma, PrismaClient } from '../../prisma/generated/client'
import type { EventRow } from './event-row'

const REFERENCE_CHAIN_LIMIT = 8

export class ForkChainTooDeep extends Error {
  constructor({ threadId, limit }: { threadId: ThreadId; limit: number }) {
    super(
      `reading ${threadId} walked more than ${limit} reference forks, which is either a cycle or a nesting depth Atlas does not support`,
    )
    this.name = 'ForkChainTooDeep'
  }
}

type Reader = Pick<PrismaClient, 'thread' | 'event'> | Prisma.TransactionClient

export async function readOwnRows({
  prisma,
  threadId,
  upTo,
  type,
}: {
  prisma: Reader
  threadId: ThreadId
  upTo?: number | undefined
  type?: string | undefined
}): Promise<EventRow[]> {
  return prisma.event.findMany({
    where: {
      threadId,
      ...(upTo === undefined ? {} : { seq: { lte: upTo } }),
      ...(type === undefined ? {} : { type }),
    },
    orderBy: { seq: 'asc' },
  })
}

export async function readComposedRows({
  prisma,
  threadId,
  upTo,
  type,
}: {
  prisma: Reader
  threadId: ThreadId
  upTo?: number | undefined
  type?: string | undefined
}): Promise<EventRow[]> {
  const segments = await planSegments({ prisma, threadId, upTo })

  const composed: EventRow[] = []
  for (const segment of segments) {
    composed.push(
      ...(await readOwnRows({
        prisma,
        threadId: segment.threadId,
        upTo: segment.upTo,
        ...(type === undefined ? {} : { type }),
      })),
    )
  }
  return composed
}

type Segment = { threadId: ThreadId; upTo: number | undefined }

async function planSegments({
  prisma,
  threadId,
  upTo,
}: {
  prisma: Reader
  threadId: ThreadId
  upTo?: number | undefined
}): Promise<Segment[]> {
  const segments: Segment[] = []
  let segment: Segment = { threadId, upTo }

  for (let hop = 0; hop < REFERENCE_CHAIN_LIMIT; hop += 1) {
    segments.unshift(segment)

    const inherited = await inheritedPrefixOf({ prisma, threadId: segment.threadId })
    if (inherited === undefined) return segments

    segment = {
      threadId: inherited.threadId,
      upTo: segment.upTo === undefined ? inherited.forkSeq : Math.min(segment.upTo, inherited.forkSeq),
    }
  }

  throw new ForkChainTooDeep({ threadId, limit: REFERENCE_CHAIN_LIMIT })
}

async function inheritedPrefixOf({
  prisma,
  threadId,
}: {
  prisma: Reader
  threadId: ThreadId
}): Promise<{ threadId: ThreadId; forkSeq: number } | undefined> {
  const link = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { parentThreadId: true, forkSeq: true, forkMode: true },
  })
  if (link === null) return undefined
  if (link.forkMode !== EForkMode.Reference) return undefined
  if (link.parentThreadId === null || link.forkSeq === null) return undefined
  return { threadId: toThreadId(link.parentThreadId), forkSeq: link.forkSeq }
}
