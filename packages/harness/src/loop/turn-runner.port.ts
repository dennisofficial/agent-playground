import type { BranchId } from '@dltech/atlas-core'

import type { TurnOutcome } from './turn-outcome'

export abstract class TurnRunner {
  abstract say(args: { branchId: BranchId; text: string; signal?: AbortSignal }): Promise<TurnOutcome>

  abstract runTurn(args: { branchId: BranchId; signal?: AbortSignal }): Promise<TurnOutcome>
}
