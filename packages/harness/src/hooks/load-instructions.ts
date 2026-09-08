import {
  BeforeTurnHook,
  EStage,
  type BeforeTurn,
  type EventDraft,
  type FileSystemPort,
  type HookOrder,
} from '@dltech/atlas-core'

import { readInstructionFiles, type InstructionRequest } from '../context/read-instructions'
import { recordLoadedFiles } from '../files/record-loaded'
import type { FileReadStatePort } from '../files/read-state'

export type InstructionPlan = { request: InstructionRequest; reload: boolean }
export type InstructionSource = (args: { projectDirectory: string }) => InstructionPlan

export class LoadInstructionsHook extends BeforeTurnHook {
  readonly name = 'instructions'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  private readonly source: InstructionSource
  private readonly files: FileSystemPort | undefined
  private readonly readState: FileReadStatePort | undefined
  private readonly seen = new Set<string>()

  constructor(args: {
    source: InstructionSource
    files?: FileSystemPort | undefined
    readState?: FileReadStatePort | undefined
  }) {
    super()
    this.source = args.source
    this.files = args.files
    this.readState = args.readState
  }

  readonly run: BeforeTurn = async ({ threadId, projectDirectory }) => {
    const plan = this.source({ projectDirectory })
    const key = `${threadId} ${projectDirectory}`
    if (!plan.reload && this.seen.has(key)) return {}

    this.seen.add(key)
    const instructions = await readInstructionFiles({
      ...plan.request,
      files: plan.request.files ?? this.files,
    })
    if (instructions.length === 0) return {}

    if (this.readState !== undefined) {
      await recordLoadedFiles({
        readState: this.readState,
        threadId,
        files: plan.request.files ?? this.files,
        loaded: instructions.map((instruction) => ({ path: instruction.path, wholeFile: true })),
      })
    }

    const drafts: readonly EventDraft[] = instructions.map((instruction) => ({
      type: 'context-loaded',
      slot: instruction.slot,
      key: instruction.path,
      content: instruction.content,
    }))

    return { drafts }
  }
}
