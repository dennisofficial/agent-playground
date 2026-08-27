import {
  ClockPort,
  IdPort,
  stampDrafts,
  type ThreadId,
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
import { readComposedRows, readOwnRows } from './compose-thread'
import { decodeEventRows, type DecodedLog } from './decode-events'
import { toEventRow } from './event-row'
import { retryOnWriteConflict } from './retry'

export type AppendArgs = {
  threadId: ThreadId
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

  async read(args: { threadId: ThreadId; upTo?: number }): Promise<Event[]> {
    const decoded = await this.readDecoded(args)
    return decoded.events
  }

  async readDecoded({ threadId, upTo }: { threadId: ThreadId; upTo?: number }): Promise<DecodedLog> {
    return decodeEventRows(await readComposedRows({ prisma: this.prisma, threadId, upTo }))
  }

  async readOwn({ threadId, upTo }: { threadId: ThreadId; upTo?: number }): Promise<Event[]> {
    return decodeEventRows(await readOwnRows({ prisma: this.prisma, threadId, upTo })).events
  }

  async head({ threadId }: { threadId: ThreadId }): Promise<number> {
    const thread = await this.prisma.thread.findUnique({
      where: { id: threadId },
      select: { head: true },
    })
    return thread?.head ?? 0
  }

  private appendOnce(args: AppendArgs): Promise<Event[]> {
    return this.prisma.$transaction(async (tx) => {
      const at = this.clock.now()
      await claimThread({ tx, threadId: args.threadId, at })

      const reusable = await loadReusableContext({ tx, threadId: args.threadId, drafts: args.drafts })
      const plan = planAppend({ drafts: args.drafts, reusable })
      if (plan.fresh.length === 0) return plan.resolve([])

      const head = await reserveSequence({ tx, threadId: args.threadId, count: plan.fresh.length, at })
      const firstSeq = head - plan.fresh.length + 1

      const prepared = plan.fresh.map((draft, index) => {
        const envelope: EventEnvelope = {
          id: this.ids.nextEventId(),
          seq: firstSeq + index,
          threadId: args.threadId,
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

async function claimThread({
  tx,
  threadId,
  at,
}: {
  tx: Prisma.TransactionClient
  threadId: ThreadId
  at: string
}): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "Thread" ("id", "title", "head", "createdAt", "updatedAt")
    VALUES (${threadId}, NULL, 0, ${at}, ${at})
    ON CONFLICT("id") DO NOTHING
  `
}

async function reserveSequence({
  tx,
  threadId,
  count,
  at,
}: {
  tx: Prisma.TransactionClient
  threadId: ThreadId
  count: number
  at: string
}): Promise<number> {
  const thread = await tx.thread.update({
    where: { id: threadId },
    data: { head: { increment: count }, updatedAt: at },
    select: { head: true },
  })
  return thread.head
}

async function loadReusableContext({
  tx,
  threadId,
  drafts,
}: {
  tx: Prisma.TransactionClient
  threadId: ThreadId
  drafts: readonly EventDraft[]
}): Promise<ReadonlyMap<ContextIdentity, Event>> {
  const wanted = new Set<ContextIdentity>()
  for (const draft of drafts) {
    const identity = contextIdentityOf(draft)
    if (identity !== undefined) wanted.add(identity)
  }
  if (wanted.size === 0) return new Map()

  const rows = await readComposedRows({ prisma: tx, threadId, type: 'context-loaded' })
  const reusable = new Map<ContextIdentity, Event>()
  for (const event of decodeEventRows(rows).events) {
    const identity = contextIdentityOf(event)
    if (identity !== undefined && wanted.has(identity)) reusable.set(identity, event)
  }
  return reusable
}
