import type { PromptContext } from './context'

export abstract class PromptFragment {
  abstract readonly id: string

  applies(_ctx: PromptContext): boolean {
    return true
  }

  abstract text(ctx: PromptContext): string
}
