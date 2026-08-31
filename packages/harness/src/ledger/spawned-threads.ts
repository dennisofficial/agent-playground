import { toThreadId, type ThreadId } from '@dltech/atlas-core'

import type { PrismaClient } from '../../prisma/generated/client'

export const SUPERVISION_DEPTH_LIMIT = 1

export class SupervisionTreeTooDeep extends Error {
  constructor({ threadId, limit }: { threadId: ThreadId; limit: number }) {
    super(
      `${threadId} supervises agents more than ${limit} level deep, and a rollup that walked only ${limit} would under-count what the operator spent`,
    )
    this.name = 'SupervisionTreeTooDeep'
  }
}

type ThreadReader = Pick<PrismaClient, 'thread'>

export async function readSpawnedThreadIds({
  prisma,
  threadId,
}: {
  prisma: ThreadReader
  threadId: ThreadId
}): Promise<ThreadId[]> {
  const collected: ThreadId[] = []
  let frontier: ThreadId[] = [threadId]

  for (let level = 0; level < SUPERVISION_DEPTH_LIMIT; level += 1) {
    frontier = await spawnedBy({ prisma, spawners: frontier })
    collected.push(...frontier)
  }

  const deeper = await spawnedBy({ prisma, spawners: frontier })
  if (deeper.length > 0) {
    throw new SupervisionTreeTooDeep({ threadId, limit: SUPERVISION_DEPTH_LIMIT })
  }

  return collected
}

async function spawnedBy({
  prisma,
  spawners,
}: {
  prisma: ThreadReader
  spawners: readonly ThreadId[]
}): Promise<ThreadId[]> {
  if (spawners.length === 0) return []

  const rows = await prisma.thread.findMany({
    where: { spawnerThreadId: { in: [...spawners] } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => toThreadId(row.id))
}
