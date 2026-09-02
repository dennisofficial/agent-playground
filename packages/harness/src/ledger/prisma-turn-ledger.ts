import { toThreadId, toRunId, type ThreadId } from '@dltech/atlas-core'

import type { PrismaClient } from '../../prisma/generated/client'
import { PrismaClientToken } from '../container/tokens'
import { retryOnWriteConflict } from '../store/retry'
import { readSpawnedThreadIds } from './spawned-threads'
import type { ThreadTreeSpend, TurnLedgerPort, TurnSpend } from './turn-ledger.port'

type TurnRow = {
  runId: string
  threadId: string
  status: string
  providerId: string
  modelId: string
  steps: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  startedAt: string
  endedAt: string
  durationMs: number
}

const toTurnSpend = (row: TurnRow): TurnSpend => ({
  runId: toRunId(row.runId),
  threadId: toThreadId(row.threadId),
  status: row.status,
  providerId: row.providerId,
  modelId: row.modelId,
  steps: row.steps,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheReadTokens: row.cacheReadTokens,
  cacheWriteTokens: row.cacheWriteTokens,
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  durationMs: row.durationMs,
})

export class PrismaTurnLedger implements TurnLedgerPort {
  constructor( private readonly prisma: PrismaClient) {}

  async record(spend: TurnSpend): Promise<void> {
    await retryOnWriteConflict({ run: () => this.recordOnce(spend) })
  }

  async forThread({ threadId }: { threadId: ThreadId }): Promise<TurnSpend[]> {
    const rows = await this.prisma.turn.findMany({
      where: { threadId },
      orderBy: { startedAt: 'asc' },
    })
    return rows.map(toTurnSpend)
  }

  async forThreadTree({ threadId }: { threadId: ThreadId }): Promise<ThreadTreeSpend> {
    const spawned = await readSpawnedThreadIds({ prisma: this.prisma, threadId })
    const rows = await this.prisma.turn.findMany({
      where: { threadId: { in: [threadId, ...spawned] } },
      orderBy: [{ startedAt: 'asc' }, { runId: 'asc' }],
    })

    const own: TurnSpend[] = []
    const delegated: TurnSpend[] = []
    for (const row of rows) {
      if (row.threadId === threadId) own.push(toTurnSpend(row))
      else delegated.push(toTurnSpend(row))
    }
    return { own, delegated }
  }

  private async recordOnce(spend: TurnSpend): Promise<void> {
    await this.prisma.turn.upsert({
      where: { runId: spend.runId },
      create: spend,
      update: spend,
    })
  }
}
