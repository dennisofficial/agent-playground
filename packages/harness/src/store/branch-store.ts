import {
  ClockPort,
  EForkMode,
  IdPort,
  toBranchId,
  type BranchId,
  type EventEnvelope,
} from '@dltech/atlas-core'

import type { PrismaClient } from '../../prisma/generated/client'
import { inject, injectable } from '../container/injection'
import { PrismaClientToken } from '../container/tokens'
import { toEventRow } from './event-row'
import { forkBranch } from './fork'

const CURRENT_CONTEXT_TYPE = 'context-loaded'

export type BranchSummary = {
  id: BranchId
  title?: string | undefined
  head: number
  createdAt: string
  updatedAt: string
  parent?: { branchId: BranchId; forkSeq: number } | undefined
}

export abstract class BranchStorePort {
  abstract create(args: { title?: string | undefined }): Promise<BranchSummary>
  abstract find(args: { branchId: BranchId }): Promise<BranchSummary | undefined>
  abstract mostRecent(): Promise<BranchSummary | undefined>
  abstract rename(args: { branchId: BranchId; title: string }): Promise<void>
  abstract rewind(args: { branchId: BranchId; toSeq: number }): Promise<void>
  abstract compact(args: {
    branchId: BranchId
    throughSeq: number
    summary: string
  }): Promise<number>

  abstract fork(args: {
    from: BranchId
    seq: number
    mode: EForkMode
    title?: string | undefined
  }): Promise<BranchSummary>
}

type BranchRow = {
  id: string
  title: string | null
  head: number
  createdAt: string
  updatedAt: string
  parentBranchId: string | null
  forkSeq: number | null
}

@injectable()
export class PrismaBranchStore implements BranchStorePort {
  constructor(
    @inject(PrismaClientToken) private readonly prisma: PrismaClient,
    private readonly clock: ClockPort,
    private readonly ids: IdPort,
  ) {}

  async create({ title }: { title?: string | undefined }): Promise<BranchSummary> {
    const at = this.clock.now()
    const row = await this.prisma.branch.create({
      data: {
        id: this.ids.nextBranchId(),
        createdAt: at,
        updatedAt: at,
        ...(title === undefined ? {} : { title }),
      },
    })
    return toBranchSummary(row)
  }

  async find({ branchId }: { branchId: BranchId }): Promise<BranchSummary | undefined> {
    const row = await this.prisma.branch.findUnique({ where: { id: branchId } })
    return row === null ? undefined : toBranchSummary(row)
  }

  async mostRecent(): Promise<BranchSummary | undefined> {
    const row = await this.prisma.branch.findFirst({ orderBy: { updatedAt: 'desc' } })
    return row === null ? undefined : toBranchSummary(row)
  }

  async rename({ branchId, title }: { branchId: BranchId; title: string }): Promise<void> {
    await this.prisma.branch.update({ where: { id: branchId }, data: { title } })
  }

  async rewind({ branchId, toSeq }: { branchId: BranchId; toSeq: number }): Promise<void> {
    const at = this.clock.now()
    await this.prisma.$transaction(async (tx) => {
      await tx.event.deleteMany({ where: { branchId, seq: { gt: toSeq } } })
      await tx.branch.update({ where: { id: branchId }, data: { head: toSeq, updatedAt: at } })
    })
  }

  async compact({
    branchId,
    throughSeq,
    summary,
  }: {
    branchId: BranchId
    throughSeq: number
    summary: string
  }): Promise<number> {
    const at = this.clock.now()

    return this.prisma.$transaction(async (tx) => {
      const compactable = { branchId, seq: { lte: throughSeq }, type: { not: CURRENT_CONTEXT_TYPE } }
      const replaced = await tx.event.count({ where: compactable })
      await tx.event.deleteMany({ where: compactable })

      const envelope: EventEnvelope = {
        id: this.ids.nextEventId(),
        seq: throughSeq,
        branchId,
        runId: this.ids.nextRunId(),
        depth: 0,
        at,
      }

      await tx.event.create({
        data: toEventRow({
          draft: { type: 'history-compacted', throughSeq, summary, replaced },
          envelope,
        }),
      })
      await tx.branch.update({ where: { id: branchId }, data: { updatedAt: at } })

      return replaced
    })
  }

  async fork({
    from,
    seq,
    mode,
    title,
  }: {
    from: BranchId
    seq: number
    mode: EForkMode
    title?: string | undefined
  }): Promise<BranchSummary> {
    const at = this.clock.now()
    const into = this.ids.nextBranchId()
    const row = await this.prisma.$transaction((tx) =>
      forkBranch({ tx, ids: this.ids, from, into, seq, mode, at, title }),
    )
    return toBranchSummary(row)
  }
}

function toBranchSummary(row: BranchRow): BranchSummary {
  return {
    id: toBranchId(row.id),
    head: row.head,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.parentBranchId === null || row.forkSeq === null
      ? {}
      : { parent: { branchId: toBranchId(row.parentBranchId), forkSeq: row.forkSeq } }),
  }
}
