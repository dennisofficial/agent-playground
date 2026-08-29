import type { SystemBlock } from '../assembly/assembled'

export enum ESkipReason {
  Condition = 'condition',
  Empty = 'empty',
}

export type PromptPart = { id: string; text: string; chars: number }

export type SkippedFragment = { id: string; reason: ESkipReason }

export type CompiledPrompt = {
  blocks: readonly SystemBlock[]
  parts: readonly PromptPart[]
  skipped: readonly SkippedFragment[]
}
