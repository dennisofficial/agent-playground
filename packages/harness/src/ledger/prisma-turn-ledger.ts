import { toBranchId, toRunId, type BranchId } from '@dltech/atlas-core'

import type { PrismaClient } from '../../prisma/generated/client'
import { inject, injectable } from '../container/injection'
import { PrismaClientToken } from '../container/tokens'
import { retryOnWriteConflict } from '../store/retry'
import type { TurnLedgerPort, TurnSpend } from './turn-ledger.port'

type TurnRow = {
  runId: string
  branchId: string
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
  branchId: toBranchId(row.branchId),
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

@injectable()
export class PrismaTurnLedger implements TurnLedgerPort {
  constructor(@inject(PrismaClientToken) private readonly prisma: PrismaClient) {}

  async record(spend: TurnSpend): Promise<void> {
    await retryOnWriteConflict({ run: () => this.recordOnce(spend) })
  }

  async forBranch({ branchId }: { branchId: BranchId }): Promise<TurnSpend[]> {
    const rows = await this.prisma.turn.findMany({
      where: { branchId },
      orderBy: { startedAt: 'asc' },
    })
    return rows.map(toTurnSpend)
  }

  private async recordOnce(spend: TurnSpend): Promise<void> {
    await this.prisma.turn.upsert({
      where: { runId: spend.runId },
      create: spend,
      update: spend,
    })
  }
}
