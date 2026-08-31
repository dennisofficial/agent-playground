import {
  ClockPort,
  ECompactionAnchor,
  EForkMode,
  IdPort,
  toThreadId,
  type ThreadId,
  type Event,
  type EventEnvelope,
} from '@dltech/atlas-core'

import type { Prisma, PrismaClient } from '../../prisma/generated/client'
import { inject, injectable } from '../container/injection'
import { PrismaClientToken } from '../container/tokens'
import { createThreadWithEvents, type OpenThreadArgs } from './create-with-events'
import { toEventRow } from './event-row'
import { forkThread } from './fork'
import { retryOnWriteConflict } from './retry'

const CURRENT_CONTEXT_TYPE = 'context-loaded'

export type SupervisedAgent = { spawnedBy: ThreadId; type: string }

export type ThreadSummary = {
  id: ThreadId
  title?: string | undefined
  head: number
  createdAt: string
  updatedAt: string
  parent?: { threadId: ThreadId; forkSeq: number } | undefined
  forkMode?: EForkMode | undefined
  agent?: SupervisedAgent | undefined
  workspace: string | null
  repo: string | null
}

export const THREAD_LISTING_LIMIT = 50

export abstract class ThreadStorePort {
  abstract create(args: {
    title?: string | undefined
    workspace?: string | undefined
    repo?: string | null | undefined
    agent?: SupervisedAgent | undefined
  }): Promise<ThreadSummary>
  abstract createWithFirstEvents(
    args: OpenThreadArgs,
  ): Promise<{ thread: ThreadSummary; events: Event[] }>
  abstract find(args: { threadId: ThreadId }): Promise<ThreadSummary | undefined>
  abstract spawned(args: { threadId: ThreadId }): Promise<readonly ThreadSummary[]>
  abstract mostRecent(args: { workspace: string }): Promise<ThreadSummary | undefined>
  abstract list(args: {
    workspace: string
    limit?: number | undefined
  }): Promise<readonly ThreadSummary[]>
  abstract rename(args: { threadId: ThreadId; title: string }): Promise<void>
  abstract adopt(args: {
    threadId: ThreadId
    workspace: string
    repo: string | null
  }): Promise<void>
  abstract rewind(args: { threadId: ThreadId; toSeq: number }): Promise<void>
  abstract compact(args: {
    threadId: ThreadId
    anchor: ECompactionAnchor
    fromSeq: number
    throughSeq: number
    summary: string
  }): Promise<number>

  abstract summarise(args: {
    threadId: ThreadId
    anchor: ECompactionAnchor
    fromSeq: number
    throughSeq: number
    summary: string
  }): Promise<number>

  abstract fork(args: {
    from: ThreadId
    seq: number
    mode: EForkMode
    title?: string | undefined
  }): Promise<ThreadSummary>
}

type ThreadRow = {
  id: string
  title: string | null
  head: number
  createdAt: string
  updatedAt: string
  parentThreadId: string | null
  forkSeq: number | null
  forkMode: string | null
  spawnerThreadId: string | null
  agentType: string | null
  workspace: string | null
  repo: string | null
}

@injectable()
export class PrismaThreadStore implements ThreadStorePort {
  constructor(
    @inject(PrismaClientToken) private readonly prisma: PrismaClient,
    private readonly clock: ClockPort,
    private readonly ids: IdPort,
  ) {}

  async create({
    title,
    workspace,
    repo,
    agent,
  }: {
    title?: string | undefined
    workspace?: string | undefined
    repo?: string | null | undefined
    agent?: SupervisedAgent | undefined
  }): Promise<ThreadSummary> {
    const at = this.clock.now()
    const row = await this.prisma.thread.create({
      data: {
        id: this.ids.nextThreadId(),
        createdAt: at,
        updatedAt: at,
        ...(title === undefined ? {} : { title }),
        ...(workspace === undefined ? {} : { workspace }),
        ...(repo === undefined ? {} : { repo }),
        ...(agent === undefined ? {} : { spawnerThreadId: agent.spawnedBy, agentType: agent.type }),
      },
    })
    return toThreadSummary(row)
  }

  async createWithFirstEvents(
    args: OpenThreadArgs,
  ): Promise<{ thread: ThreadSummary; events: Event[] }> {
    return retryOnWriteConflict({ run: () => this.createWithFirstEventsOnce(args) })
  }

  async find({ threadId }: { threadId: ThreadId }): Promise<ThreadSummary | undefined> {
    const row = await this.prisma.thread.findUnique({ where: { id: threadId } })
    return row === null ? undefined : toThreadSummary(row)
  }

  async spawned({ threadId }: { threadId: ThreadId }): Promise<readonly ThreadSummary[]> {
    const rows = await this.prisma.thread.findMany({
      where: { spawnerThreadId: threadId },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map(toThreadSummary)
  }

  async mostRecent({ workspace }: { workspace: string }): Promise<ThreadSummary | undefined> {
    const row = await this.prisma.thread.findFirst({
      where: { workspace },
      orderBy: { updatedAt: 'desc' },
    })
    return row === null ? undefined : toThreadSummary(row)
  }

  async list({
    workspace,
    limit = THREAD_LISTING_LIMIT,
  }: {
    workspace: string
    limit?: number | undefined
  }): Promise<readonly ThreadSummary[]> {
    const rows = await this.prisma.thread.findMany({
      where: { workspace },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    })
    return rows.map(toThreadSummary)
  }

  async rename({ threadId, title }: { threadId: ThreadId; title: string }): Promise<void> {
    await this.prisma.thread.update({ where: { id: threadId }, data: { title } })
  }

  async adopt({
    threadId,
    workspace,
    repo,
  }: {
    threadId: ThreadId
    workspace: string
    repo: string | null
  }): Promise<void> {
    await this.prisma.thread.update({ where: { id: threadId }, data: { workspace, repo } })
  }

  async rewind({ threadId, toSeq }: { threadId: ThreadId; toSeq: number }): Promise<void> {
    const at = this.clock.now()
    await this.prisma.$transaction(async (tx) => {
      await tx.event.deleteMany({ where: { threadId, seq: { gt: toSeq } } })
      await tx.thread.update({ where: { id: threadId }, data: { head: toSeq, updatedAt: at } })
    })
  }

  async compact(args: {
    threadId: ThreadId
    anchor: ECompactionAnchor
    fromSeq: number
    throughSeq: number
    summary: string
  }): Promise<number> {
    return this.mark({ ...args, discardRows: false })
  }

  async summarise(args: {
    threadId: ThreadId
    anchor: ECompactionAnchor
    fromSeq: number
    throughSeq: number
    summary: string
  }): Promise<number> {
    return this.mark({ ...args, discardRows: true })
  }

  /**
   * Compaction hides a range from the model; summarisation replaces it. They differ only in whether
   * the rows go, so the watermark is written the same way for both: appended past the head when the
   * rows stay, standing in their place when they do not.
   */
  private async mark({
    threadId,
    anchor,
    fromSeq,
    throughSeq,
    summary,
    discardRows,
  }: {
    threadId: ThreadId
    anchor: ECompactionAnchor
    fromSeq: number
    throughSeq: number
    summary: string
    discardRows: boolean
  }): Promise<number> {
    const at = this.clock.now()

    return this.prisma.$transaction(async (tx) => {
      const covered = {
        threadId,
        seq: { gte: fromSeq, lte: throughSeq },
        type: { not: CURRENT_CONTEXT_TYPE },
      }
      const replaced = await tx.event.count({ where: covered })
      if (discardRows) await tx.event.deleteMany({ where: covered })

      const seq = discardRows
        ? standInSeq({ anchor, fromSeq, throughSeq })
        : await reserveOne({ tx, threadId, at })

      const envelope: EventEnvelope = {
        id: this.ids.nextEventId(),
        seq,
        threadId,
        runId: this.ids.nextRunId(),
        depth: 0,
        at,
      }

      await tx.event.create({
        data: toEventRow({
          draft: { type: 'history-compacted', anchor, fromSeq, throughSeq, summary, replaced },
          envelope,
        }),
      })
      await tx.thread.update({ where: { id: threadId }, data: { updatedAt: at } })

      return replaced
    })
  }

  async fork({
    from,
    seq,
    mode,
    title,
  }: {
    from: ThreadId
    seq: number
    mode: EForkMode
    title?: string | undefined
  }): Promise<ThreadSummary> {
    const at = this.clock.now()
    const into = this.ids.nextThreadId()
    const row = await this.prisma.$transaction((tx) =>
      forkThread({ tx, ids: this.ids, from, into, seq, mode, at, title }),
    )
    return toThreadSummary({ ...row, spawnerThreadId: null, agentType: null })
  }

  private createWithFirstEventsOnce({
    drafts,
    runId,
    title,
    workspace,
    repo,
    agent,
  }: OpenThreadArgs): Promise<{ thread: ThreadSummary; events: Event[] }> {
    return this.prisma.$transaction(async (tx) => {
      const { threadId, events } = await createThreadWithEvents({
        tx,
        ids: this.ids,
        clock: this.clock,
        drafts,
        runId,
        title,
        workspace,
        repo,
        agent,
      })
      const row = await tx.thread.findUniqueOrThrow({ where: { id: threadId } })
      return { thread: toThreadSummary(row), events }
    })
  }
}

function toThreadSummary(row: ThreadRow): ThreadSummary {
  return {
    id: toThreadId(row.id),
    head: row.head,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    workspace: row.workspace,
    repo: row.repo,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.parentThreadId === null || row.forkSeq === null
      ? {}
      : { parent: { threadId: toThreadId(row.parentThreadId), forkSeq: row.forkSeq } }),
    ...forkModeOf(row.forkMode),
    ...supervisedAgentOf(row),
  }
}

function forkModeOf(stored: string | null): { forkMode?: EForkMode } {
  if (stored === EForkMode.Reference) return { forkMode: EForkMode.Reference }
  if (stored === EForkMode.Copy) return { forkMode: EForkMode.Copy }
  return {}
}

function supervisedAgentOf(row: ThreadRow): { agent?: SupervisedAgent } {
  if (row.spawnerThreadId === null || row.agentType === null) return {}
  return { agent: { spawnedBy: toThreadId(row.spawnerThreadId), type: row.agentType } }
}

const standInSeq = ({
  anchor,
  fromSeq,
  throughSeq,
}: {
  anchor: ECompactionAnchor
  fromSeq: number
  throughSeq: number
}): number => (anchor === ECompactionAnchor.Prefix ? throughSeq : fromSeq)

async function reserveOne({
  tx,
  threadId,
  at,
}: {
  tx: Prisma.TransactionClient
  threadId: ThreadId
  at: string
}): Promise<number> {
  const thread = await tx.thread.update({
    where: { id: threadId },
    data: { head: { increment: 1 }, updatedAt: at },
    select: { head: true },
  })
  return thread.head
}
