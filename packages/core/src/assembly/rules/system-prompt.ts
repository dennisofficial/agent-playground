import type { CompiledPrompt } from '../../prompt/compiled'
import { defineRule, type Rule } from '../rule'

export const EMPTY_PROMPT: CompiledPrompt = { blocks: [], parts: [], skipped: [] }

export type PromptSource = () => CompiledPrompt

export function systemPrompt({ prompt }: { prompt: PromptSource }): Rule {
  return defineRule({
    name: 'systemPrompt',
    apply: (input) => ({
      system: [...input.system, ...prompt().blocks],
      messages: input.messages,
    }),
  })
}
