import {
  EPromptAgent,
  memoryPromptText,
  PromptFragment,
  type MemoryPromptDirectories,
  type PromptContext,
} from '@dltech/atlas-core'

export class MemoryFragment extends PromptFragment {
  readonly id = 'memory.instructions'

  private readonly rendered: string

  constructor(args: { directories: MemoryPromptDirectories }) {
    super()
    this.rendered = memoryPromptText(args.directories)
  }

  override applies(ctx: PromptContext): boolean {
    return ctx.agent === EPromptAgent.Main
  }

  text(): string {
    return this.rendered
  }
}
