import {
  AfterToolHook,
  EStage,
  EToolEffect,
  WorkspaceFactsPort,
  type AfterTool,
  type HookOrder,
} from '@dltech/atlas-core'

import { inject, injectable, portToken } from '../container/injection'

@injectable()
export class InvalidateFactsHook extends AfterToolHook {
  readonly name = 'invalidateFacts'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 2 }

  private readonly facts: WorkspaceFactsPort

  constructor(@inject(portToken(WorkspaceFactsPort)) facts: WorkspaceFactsPort) {
    super()
    this.facts = facts
  }

  readonly run: AfterTool = async ({ call }) => {
    if (call.effect === EToolEffect.Read) return {}

    this.facts.invalidate()
    return {}
  }
}
