import {
  ClockPort,
  IdPort,
  stampDrafts,
  type BranchId,
  type Event,
  type EventDraft,
  type EventEnvelope,
  type EventLogPort,
  type RunId,
} from '@dltech/atlas-core'

import type { Prisma, PrismaClient } from '../../prisma/generated/client'
import { inject, injectable } from '../container/injection'
import { PrismaClientToken } from '../container/tokens'
import { contextIdentityOf, planAppend, type ContextIdentity } from './append-plan'
import { decodeEventRows, type DecodedLog } from './decode-events'
import { toEventRow } from './event-row'
import { retryOnWriteConflict } from './retry'

export type AppendArgs = {
  branchId: BranchId
  runId: RunId
  drafts: readonly EventDraft[]
  parentRunId?: RunId | undefined
  depth?: number | undefined
}

@injectable()
export class PrismaEventLog implements EventLogPort {
  constructor(
    @inject(PrismaClientToken) private readonly prisma: PrismaClient,
    private readonly clock: ClockPort,
    private readonly ids: IdPort,
  ) {}

  async append(args: AppendArgs): Promise<Event[]> {
    if (args.drafts.length === 0) return []
    return retryOnWriteConflict({ run: () => this.appendOnce(args) })
  }

  async read(args: { branchId: BranchId; upTo?: number }): Promise<Event[]> {
    const decoded = await this.readDecoded(args)
    return decoded.events
  }

  async readDecoded({ branchId, upTo }: { branchId: BranchId; upTo?: number }): Promise<DecodedLog> {
    const rows = await this.prisma.event.findMany({
      where: { branchId, ...(upTo === undefined ? {} : { seq: { lte: upTo } }) },
      orderBy: { seq: 'asc' },
    })
    return decodeEventRows(rows)
  }

  async head({ branchId }: { branchId: BranchId }): Promise<number> {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { head: true },
    })
    return branch?.head ?? 0
  }

  async forkFrom(args: { branchId: BranchId; seq: number; into: BranchId }): Promise<void> {
    throw new Error(
      `PrismaEventLog.forkFrom is not implemented (asked to fork ${args.branchId} at ${args.seq} into ${args.into})`,
    )
  }

  private appendOnce(args: AppendArgs): Promise<Event[]> {
    return this.prisma.$transaction(async (tx) => {
      const at = this.clock.now()
      await claimBranch({ tx, branchId: args.branchId, at })

      const reusable = await loadReusableContext({ tx, branchId: args.branchId, drafts: args.drafts })
      const plan = planAppend({ drafts: args.drafts, reusable })
      if (plan.fresh.length === 0) return plan.resolve([])

      const head = await reserveSequence({ tx, branchId: args.branchId, count: plan.fresh.length, at })
      const firstSeq = head - plan.fresh.length + 1

      const prepared = plan.fresh.map((draft, index) => {
        const envelope: EventEnvelope = {
          id: this.ids.nextEventId(),
          seq: firstSeq + index,
          branchId: args.branchId,
          runId: args.runId,
          depth: args.depth ?? 0,
          at,
          ...(args.parentRunId === undefined ? {} : { parentRunId: args.parentRunId }),
        }
        return { draft, envelope, row: toEventRow({ draft, envelope }) }
      })

      await tx.event.createMany({ data: prepared.map((entry) => entry.row) })

      return plan.resolve(
        stampDrafts({
          drafts: prepared.map((entry) => entry.draft),
          envelopes: prepared.map((entry) => entry.envelope),
        }),
      )
    })
  }
}

async function claimBranch({
  tx,
  branchId,
  at,
}: {
  tx: Prisma.TransactionClient
  branchId: BranchId
  at: string
}): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "Branch" ("id", "title", "head", "createdAt", "updatedAt")
    VALUES (${branchId}, NULL, 0, ${at}, ${at})
    ON CONFLICT("id") DO NOTHING
  `
}

async function reserveSequence({
  tx,
  branchId,
  count,
  at,
}: {
  tx: Prisma.TransactionClient
  branchId: BranchId
  count: number
  at: string
}): Promise<number> {
  const branch = await tx.branch.update({
    where: { id: branchId },
    data: { head: { increment: count }, updatedAt: at },
    select: { head: true },
  })
  return branch.head
}

async function loadReusableContext({
  tx,
  branchId,
  drafts,
}: {
  tx: Prisma.TransactionClient
  branchId: BranchId
  drafts: readonly EventDraft[]
}): Promise<ReadonlyMap<ContextIdentity, Event>> {
  const wanted = new Set<ContextIdentity>()
  for (const draft of drafts) {
    const identity = contextIdentityOf(draft)
    if (identity !== undefined) wanted.add(identity)
  }
  if (wanted.size === 0) return new Map()

  const rows = await tx.event.findMany({ where: { branchId, type: 'context-loaded' } })
  const reusable = new Map<ContextIdentity, Event>()
  for (const event of decodeEventRows(rows).events) {
    const identity = contextIdentityOf(event)
    if (identity !== undefined && wanted.has(identity)) reusable.set(identity, event)
  }
  return reusable
}
