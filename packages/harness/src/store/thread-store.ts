import {
  ClockPort,
  EForkMode,
  IdPort,
  toThreadId,
  type ThreadId,
  type EventEnvelope,
} from '@dltech/atlas-core'

import type { PrismaClient } from '../../prisma/generated/client'
import { inject, injectable } from '../container/injection'
import { PrismaClientToken } from '../container/tokens'
import { toEventRow } from './event-row'
import { forkThread } from './fork'

const CURRENT_CONTEXT_TYPE = 'context-loaded'

export type ThreadSummary = {
  id: ThreadId
  title?: string | undefined
  head: number
  createdAt: string
  updatedAt: string
  parent?: { threadId: ThreadId; forkSeq: number } | undefined
}

export abstract class ThreadStorePort {
  abstract create(args: { title?: string | undefined }): Promise<ThreadSummary>
  abstract find(args: { threadId: ThreadId }): Promise<ThreadSummary | undefined>
  abstract mostRecent(): Promise<ThreadSummary | undefined>
  abstract rename(args: { threadId: ThreadId; title: string }): Promise<void>
  abstract rewind(args: { threadId: ThreadId; toSeq: number }): Promise<void>
  abstract compact(args: {
    threadId: ThreadId
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
}

@injectable()
export class PrismaThreadStore implements ThreadStorePort {
  constructor(
    @inject(PrismaClientToken) private readonly prisma: PrismaClient,
    private readonly clock: ClockPort,
    private readonly ids: IdPort,
  ) {}

  async create({ title }: { title?: string | undefined }): Promise<ThreadSummary> {
    const at = this.clock.now()
    const row = await this.prisma.thread.create({
      data: {
        id: this.ids.nextThreadId(),
        createdAt: at,
        updatedAt: at,
        ...(title === undefined ? {} : { title }),
      },
    })
    return toThreadSummary(row)
  }

  async find({ threadId }: { threadId: ThreadId }): Promise<ThreadSummary | undefined> {
    const row = await this.prisma.thread.findUnique({ where: { id: threadId } })
    return row === null ? undefined : toThreadSummary(row)
  }

  async mostRecent(): Promise<ThreadSummary | undefined> {
    const row = await this.prisma.thread.findFirst({ orderBy: { updatedAt: 'desc' } })
    return row === null ? undefined : toThreadSummary(row)
  }

  async rename({ threadId, title }: { threadId: ThreadId; title: string }): Promise<void> {
    await this.prisma.thread.update({ where: { id: threadId }, data: { title } })
  }

  async rewind({ threadId, toSeq }: { threadId: ThreadId; toSeq: number }): Promise<void> {
    const at = this.clock.now()
    await this.prisma.$transaction(async (tx) => {
      await tx.event.deleteMany({ where: { threadId, seq: { gt: toSeq } } })
      await tx.thread.update({ where: { id: threadId }, data: { head: toSeq, updatedAt: at } })
    })
  }

  async compact({
    threadId,
    throughSeq,
    summary,
  }: {
    threadId: ThreadId
    throughSeq: number
    summary: string
  }): Promise<number> {
    const at = this.clock.now()

    return this.prisma.$transaction(async (tx) => {
      const compactable = { threadId, seq: { lte: throughSeq }, type: { not: CURRENT_CONTEXT_TYPE } }
      const replaced = await tx.event.count({ where: compactable })
      await tx.event.deleteMany({ where: compactable })

      const envelope: EventEnvelope = {
        id: this.ids.nextEventId(),
        seq: throughSeq,
        threadId,
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
    return toThreadSummary(row)
  }
}

function toThreadSummary(row: ThreadRow): ThreadSummary {
  return {
    id: toThreadId(row.id),
    head: row.head,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.parentThreadId === null || row.forkSeq === null
      ? {}
      : { parent: { threadId: toThreadId(row.parentThreadId), forkSeq: row.forkSeq } }),
  }
}
