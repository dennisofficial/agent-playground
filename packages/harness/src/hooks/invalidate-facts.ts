import {
  AfterToolHook,
  EStage,
  EToolEffect,
  WorkspaceFactsPort,
  type AfterTool,
  type HookOrder,
} from '@dltech/atlas-core'

import {  portToken } from '../container/injection'

export class InvalidateFactsHook extends AfterToolHook {
  readonly name = 'invalidateFacts'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 2 }

  private readonly facts: WorkspaceFactsPort

  constructor( facts: WorkspaceFactsPort) {
    super()
    this.facts = facts
  }

  readonly run: AfterTool = async ({ call }) => {
    if (call.effect === EToolEffect.Read) return {}

    this.facts.invalidate()
    return {}
  }
}
