import type { CompiledPrompt } from '../../prompt/compiled'
import { projectDirectoryOf } from '../../workspace/worktree'
import { defineRule, type Rule } from '../rule'

export const EMPTY_PROMPT: CompiledPrompt = { blocks: [], parts: [], skipped: [] }

export type PromptSource = (args: { projectDirectory: string }) => CompiledPrompt

export function systemPrompt({
  prompt,
  launchDirectory,
}: {
  prompt: PromptSource
  launchDirectory: string
}): Rule {
  return defineRule({
    name: 'systemPrompt',
    apply: (input, ctx) => ({
      system: [
        ...input.system,
        ...prompt({ projectDirectory: projectDirectoryOf({ events: ctx.events, launchDirectory }) })
          .blocks,
      ],
      messages: input.messages,
    }),
  })
}
