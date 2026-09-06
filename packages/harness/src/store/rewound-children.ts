import type { ThreadId } from '@dltech/atlas-core'

import type { Prisma } from '../../prisma/generated/client'

/**
 * The fork-check read must stay inside the caller's transaction and behind its first write: SQLite
 * takes only a shared lock for a leading read, and upgrading it deadlocks against a concurrent
 * append instead of queueing.
 */
export async function dropRewoundChildren({
  tx,
  agentIds,
}: {
  tx: Prisma.TransactionClient
  agentIds: readonly ThreadId[]
}): Promise<void> {
  if (agentIds.length === 0) return

  const referenced = await tx.thread.findMany({
    where: { id: { in: [...agentIds] }, OR: [{ forks: { some: {} } }, { spawned: { some: {} } }] },
    select: { id: true },
  })
  const referencedIds = new Set(referenced.map((row) => row.id))

  if (referencedIds.size > 0) {
    await tx.thread.updateMany({
      where: { id: { in: [...referencedIds] } },
      data: { spawnerThreadId: null, agentType: null },
    })
  }

  const removable = agentIds.filter((agentId) => !referencedIds.has(agentId))
  if (removable.length > 0) {
    await tx.thread.deleteMany({ where: { id: { in: removable } } })
  }
}
