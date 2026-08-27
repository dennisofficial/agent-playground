import { ClockPort, IdPort, toBranchId, type BranchId } from '@dltech/atlas-core'

import type { PrismaClient } from '../../prisma/generated/client'
import { inject, injectable } from '../container/injection'
import { PrismaClientToken } from '../container/tokens'

export type BranchSummary = {
  id: BranchId
  title?: string | undefined
  head: number
  createdAt: string
  updatedAt: string
}

export abstract class BranchStorePort {
  abstract create(args: { title?: string | undefined }): Promise<BranchSummary>
  abstract find(args: { branchId: BranchId }): Promise<BranchSummary | undefined>
  abstract mostRecent(): Promise<BranchSummary | undefined>
  abstract rename(args: { branchId: BranchId; title: string }): Promise<void>
}

type BranchRow = {
  id: string
  title: string | null
  head: number
  createdAt: string
  updatedAt: string
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
}

function toBranchSummary(row: BranchRow): BranchSummary {
  return {
    id: toBranchId(row.id),
    head: row.head,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.title === null ? {} : { title: row.title }),
  }
}
