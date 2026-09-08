import {
  BeforeTurnHook,
  EStage,
  type BeforeTurn,
  type EventDraft,
  type HookOrder,
} from '@dltech/atlas-core'

import { recordLoadedFiles } from '../files/record-loaded'
import type { FileReadStatePort } from '../files/read-state'
import {
  ensureMemoryDirectories,
  readMemoryIndexes,
  type MemoryDirectories,
} from '../memory/read-memory'

export type MemoryProblemReporter = (args: { path: string; reason: string }) => void

export class LoadMemoryHook extends BeforeTurnHook {
  readonly name = 'memory'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  private readonly directories: MemoryDirectories
  private readonly report: MemoryProblemReporter | undefined
  private readonly readState: FileReadStatePort | undefined
  private prepared = false

  constructor(args: {
    directories: MemoryDirectories
    report?: MemoryProblemReporter
    readState?: FileReadStatePort | undefined
  }) {
    super()
    this.directories = args.directories
    this.report = args.report
    this.readState = args.readState
  }

  readonly run: BeforeTurn = async ({ threadId }) => {
    if (!this.prepared) {
      this.prepared = true
      await ensureMemoryDirectories(this.directories)
    }

    const { indexes, problems } = await readMemoryIndexes(this.directories)
    for (const problem of problems) this.report?.(problem)

    if (indexes.length === 0) return {}

    if (this.readState !== undefined) {
      await recordLoadedFiles({
        readState: this.readState,
        threadId,
        loaded: indexes.map((index) => ({ path: index.path, wholeFile: index.wholeFile })),
      })
    }

    const drafts: readonly EventDraft[] = indexes.map((index) => ({
      type: 'context-loaded',
      slot: index.slot,
      key: index.path,
      content: index.content,
    }))

    return { drafts }
  }
}
