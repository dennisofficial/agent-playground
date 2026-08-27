import {
  addUsage,
  NOTHING_BILLED,
  type BilledUsage,
  type BranchId,
  type ClockPort,
  type ModelUsage,
  type ProviderIdentity,
  type RunId,
} from '@dltech/atlas-core'

import type { TurnLedgerPort } from './turn-ledger.port'

export const TURN_CRASHED = 'crashed'

export type TurnLedgerDeps = {
  ledger?: TurnLedgerPort | undefined
  clock?: ClockPort | undefined
  onLedgerFailure?: ((error: unknown) => void) | undefined
}

export type RecordTurnSpendArgs = TurnLedgerDeps & {
  branchId: BranchId
  runId: RunId
  status: string
  model: ProviderIdentity
  steps: number
  usage: BilledUsage
  startedAt: string
  endedAt: string
}

const elapsedMs = ({ startedAt, endedAt }: { startedAt: string; endedAt: string }): number => {
  const span = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(span) && span > 0 ? span : 0
}

export async function recordTurnSpend(args: RecordTurnSpendArgs): Promise<void> {
  const { ledger, startedAt, endedAt } = args
  if (ledger === undefined) return
  if (args.steps === 0 && args.status !== TURN_CRASHED) return

  try {
    await ledger.record({
      runId: args.runId,
      branchId: args.branchId,
      status: args.status,
      providerId: args.model.id,
      modelId: args.model.modelId,
      steps: args.steps,
      ...args.usage,
      startedAt,
      endedAt,
      durationMs: elapsedMs({ startedAt, endedAt }),
    })
  } catch (error) {
    args.onLedgerFailure?.(error)
  }
}

export type TurnSpendTally = {
  countStep(usage: ModelUsage | undefined): void
  settle(args: { branchId: BranchId; runId: RunId; status: string }): Promise<void>
}

export function openTurnSpend(args: TurnLedgerDeps & { model: ProviderIdentity }): TurnSpendTally {
  const nowOf = (): string => args.clock?.now() ?? new Date().toISOString()
  const startedAt = nowOf()
  let usage: BilledUsage = NOTHING_BILLED
  let steps = 0

  return {
    countStep(reported) {
      steps += 1
      usage = addUsage({ billed: usage, step: reported })
    },

    settle: ({ branchId, runId, status }) =>
      recordTurnSpend({
        ...args,
        branchId,
        runId,
        status,
        steps,
        usage,
        startedAt,
        endedAt: nowOf(),
      }),
  }
}
