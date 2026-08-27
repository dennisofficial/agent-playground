import { EForkMode, toBranchId, type BranchId } from '@dltech/atlas-core'

import type { Prisma, PrismaClient } from '../../prisma/generated/client'
import type { EventRow } from './event-row'

const REFERENCE_CHAIN_LIMIT = 8

export class ForkChainTooDeep extends Error {
  constructor({ branchId, limit }: { branchId: BranchId; limit: number }) {
    super(
      `reading ${branchId} walked more than ${limit} reference forks, which is either a cycle or a nesting depth Atlas does not support`,
    )
    this.name = 'ForkChainTooDeep'
  }
}

type Reader = Pick<PrismaClient, 'branch' | 'event'> | Prisma.TransactionClient

export async function readOwnRows({
  prisma,
  branchId,
  upTo,
  type,
}: {
  prisma: Reader
  branchId: BranchId
  upTo?: number | undefined
  type?: string | undefined
}): Promise<EventRow[]> {
  return prisma.event.findMany({
    where: {
      branchId,
      ...(upTo === undefined ? {} : { seq: { lte: upTo } }),
      ...(type === undefined ? {} : { type }),
    },
    orderBy: { seq: 'asc' },
  })
}

export async function readComposedRows({
  prisma,
  branchId,
  upTo,
  type,
}: {
  prisma: Reader
  branchId: BranchId
  upTo?: number | undefined
  type?: string | undefined
}): Promise<EventRow[]> {
  const segments = await planSegments({ prisma, branchId, upTo })

  const composed: EventRow[] = []
  for (const segment of segments) {
    composed.push(
      ...(await readOwnRows({
        prisma,
        branchId: segment.branchId,
        upTo: segment.upTo,
        ...(type === undefined ? {} : { type }),
      })),
    )
  }
  return composed
}

type Segment = { branchId: BranchId; upTo: number | undefined }

async function planSegments({
  prisma,
  branchId,
  upTo,
}: {
  prisma: Reader
  branchId: BranchId
  upTo?: number | undefined
}): Promise<Segment[]> {
  const segments: Segment[] = []
  let segment: Segment = { branchId, upTo }

  for (let hop = 0; hop < REFERENCE_CHAIN_LIMIT; hop += 1) {
    segments.unshift(segment)

    const inherited = await inheritedPrefixOf({ prisma, branchId: segment.branchId })
    if (inherited === undefined) return segments

    segment = {
      branchId: inherited.branchId,
      upTo: segment.upTo === undefined ? inherited.forkSeq : Math.min(segment.upTo, inherited.forkSeq),
    }
  }

  throw new ForkChainTooDeep({ branchId, limit: REFERENCE_CHAIN_LIMIT })
}

async function inheritedPrefixOf({
  prisma,
  branchId,
}: {
  prisma: Reader
  branchId: BranchId
}): Promise<{ branchId: BranchId; forkSeq: number } | undefined> {
  const link = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { parentBranchId: true, forkSeq: true, forkMode: true },
  })
  if (link === null) return undefined
  if (link.forkMode !== EForkMode.Reference) return undefined
  if (link.parentBranchId === null || link.forkSeq === null) return undefined
  return { branchId: toBranchId(link.parentBranchId), forkSeq: link.forkSeq }
}
