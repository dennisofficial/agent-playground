import { EForkMode, type ThreadId, type IdPort } from '@dltech/atlas-core'

import type { Prisma } from '../../prisma/generated/client'

export class ForkSourceMissing extends Error {
  constructor({ from }: { from: ThreadId }) {
    super(`cannot fork ${from}: no such thread`)
    this.name = 'ForkSourceMissing'
  }
}

export class ForkSeqOutOfRange extends Error {
  constructor({ from, seq, head }: { from: ThreadId; seq: number; head: number }) {
    super(`cannot fork ${from} at ${seq}: the thread runs from 0 to ${head}`)
    this.name = 'ForkSeqOutOfRange'
  }
}

export type ForkedThreadRow = {
  id: string
  title: string | null
  head: number
  createdAt: string
  updatedAt: string
  parentThreadId: string | null
  forkSeq: number | null
  forkMode: string | null
  workspace: string | null
  repo: string | null
  modelRef: string | null
  modelEffort: string | null
  executionLocation: string | null
}

export async function forkThread({
  tx,
  ids,
  from,
  into,
  seq,
  mode,
  at,
  title,
}: {
  tx: Prisma.TransactionClient
  ids: IdPort
  from: ThreadId
  into: ThreadId
  seq: number
  mode: EForkMode
  at: string
  title?: string | undefined
}): Promise<ForkedThreadRow> {
  const source = await tx.thread.findUnique({
    where: { id: from },
    select: {
      head: true,
      workspace: true,
      repo: true,
      modelRef: true,
      modelEffort: true,
      executionLocation: true,
    },
  })
  if (source === null) throw new ForkSourceMissing({ from })
  if (seq < 0 || seq > source.head) throw new ForkSeqOutOfRange({ from, seq, head: source.head })

  const row = await tx.thread.create({
    data: {
      id: into,
      head: seq,
      createdAt: at,
      updatedAt: at,
      parentThreadId: from,
      forkSeq: seq,
      forkMode: mode,
      workspace: source.workspace,
      repo: source.repo,
      modelRef: source.modelRef,
      modelEffort: source.modelEffort,
      executionLocation: source.executionLocation,
      ...(title === undefined ? {} : { title }),
    },
  })

  if (mode === EForkMode.Copy) await copyRows({ tx, ids, from, into, upTo: seq })

  return row
}

async function copyRows({
  tx,
  ids,
  from,
  into,
  upTo,
}: {
  tx: Prisma.TransactionClient
  ids: IdPort
  from: ThreadId
  into: ThreadId
  upTo: number
}): Promise<void> {
  const rows = await tx.event.findMany({
    where: { threadId: from, seq: { lte: upTo } },
    orderBy: { seq: 'asc' },
  })
  if (rows.length === 0) return

  await tx.event.createMany({
    data: rows.map((row) => ({ ...row, id: ids.nextEventId(), threadId: into })),
  })
}
