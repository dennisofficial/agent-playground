import {
  BeforeTurnHook,
  EStage,
  type BeforeTurn,
  type EventDraft,
  type HookOrder,
} from '@dltech/atlas-core'

import { readInstructionFiles, type InstructionRequest } from '../context/read-instructions'

export type InstructionPlan = { request: InstructionRequest; reload: boolean }
export type InstructionSource = () => InstructionPlan

export class LoadInstructionsHook extends BeforeTurnHook {
  readonly name = 'instructions'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  private readonly source: InstructionSource
  private readonly seen = new Set<string>()

  constructor(args: { source: InstructionSource }) {
    super()
    this.source = args.source
  }

  readonly run: BeforeTurn = async ({ threadId }) => {
    const plan = this.source()
    if (!plan.reload && this.seen.has(threadId)) return {}

    this.seen.add(threadId)
    const instructions = await readInstructionFiles(plan.request)
    if (instructions.length === 0) return {}

    const drafts: readonly EventDraft[] = instructions.map((instruction) => ({
      type: 'context-loaded',
      slot: instruction.slot,
      key: instruction.path,
      content: instruction.content,
    }))

    return { drafts }
  }
}
