import {
  BeforeTurnHook,
  EStage,
  type BeforeTurn,
  type EventDraft,
  type HookOrder,
} from '@dltech/atlas-core'

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
  private prepared = false

  constructor(args: { directories: MemoryDirectories; report?: MemoryProblemReporter }) {
    super()
    this.directories = args.directories
    this.report = args.report
  }

  readonly run: BeforeTurn = async () => {
    if (!this.prepared) {
      this.prepared = true
      await ensureMemoryDirectories(this.directories)
    }

    const { indexes, problems } = await readMemoryIndexes(this.directories)
    for (const problem of problems) this.report?.(problem)

    if (indexes.length === 0) return {}

    const drafts: readonly EventDraft[] = indexes.map((index) => ({
      type: 'context-loaded',
      slot: index.slot,
      key: index.path,
      content: index.content,
    }))

    return { drafts }
  }
}
