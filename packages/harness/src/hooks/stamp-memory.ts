import {
  BeforeToolHook,
  ClockPort,
  EBeforeToolDecision,
  EStage,
  isMemoryFile,
  withRecordedDate,
  type BeforeTool,
  type HookOrder,
} from '@dltech/atlas-core'
import { z } from 'zod'

import { localDayOf } from '../time/local-day'

const WHOLE_FILE_WRITER = 'write'

const writeInput = z.object({ path: z.string(), content: z.string() })

export class StampMemoryHook extends BeforeToolHook {
  readonly name = 'stampMemory'
  readonly order: HookOrder = { stage: EStage.Guard, nudge: 2 }

  private readonly directories: readonly string[]
  private readonly clock: ClockPort

  constructor(args: { directories: readonly string[]; clock: ClockPort }) {
    super()
    this.directories = args.directories
    this.clock = args.clock
  }

  readonly run: BeforeTool = async ({ call }) => {
    const unchanged = { decision: EBeforeToolDecision.Allow, input: call.input } as const
    if (call.name !== WHOLE_FILE_WRITER) return unchanged

    const parsed = writeInput.safeParse(call.input)
    if (!parsed.success) return unchanged

    const { path, content } = parsed.data
    if (!isMemoryFile({ path, directories: this.directories })) return unchanged

    const date = localDayOf(this.clock.now())
    if (date === '') return unchanged

    const stamped = withRecordedDate({ content, date })
    if (stamped === content) return unchanged

    return { decision: EBeforeToolDecision.Allow, input: { path, content: stamped } }
  }
}
