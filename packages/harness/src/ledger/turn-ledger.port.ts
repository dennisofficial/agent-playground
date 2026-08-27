import type { BranchId, RunId } from '@dltech/atlas-core'

// Cache reads and cache writes bill at different rates from ordinary input tokens, and both are
// counted inside `inputTokens` rather than on top of it.
export type TurnSpend = {
  runId: RunId
  branchId: BranchId
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

export abstract class TurnLedgerPort {
  abstract record(spend: TurnSpend): Promise<void>
  abstract forBranch(args: { branchId: BranchId }): Promise<TurnSpend[]>
}
