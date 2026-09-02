import {
  BeforeTurnHook,
  EStage,
  WorkspaceFactsPort,
  type BeforeTurn,
  type HookOrder,
} from '@dltech/atlas-core'

import {  portToken } from '../container/injection'
import { WorkspaceRoot } from '../container/tokens'

export class PrewarmFactsHook extends BeforeTurnHook {
  readonly name = 'prewarmFacts'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 1 }

  private readonly facts: WorkspaceFactsPort
  private readonly launchDirectory: string

  constructor(
     facts: WorkspaceFactsPort,
     launchDirectory: string,
  ) {
    super()
    this.facts = facts
    this.launchDirectory = launchDirectory
  }

  readonly run: BeforeTurn = async ({ projectDirectory }) => {
    this.facts.prewarm({ projectDirectory, launchDirectory: this.launchDirectory })
    return {}
  }
}
