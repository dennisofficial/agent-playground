import type { ToolDeclaration } from '../../tools/tool'
import { defineRule, type Rule } from '../rule'

export const MINIMAL_PREAMBLE = [
  'You are Atlas, a coding agent talking to a developer in their terminal.',
  'Answer directly and concisely, and prefer using a tool over describing what you would do.',
].join('\n')

export type PreambleWorkspace = { root: string; tools: readonly ToolDeclaration[] }

function preambleFor(workspace: PreambleWorkspace | undefined): string {
  if (workspace === undefined) return MINIMAL_PREAMBLE

  const lines = [
    MINIMAL_PREAMBLE,
    `The workspace root is ${workspace.root}. Every path you pass to a tool must be absolute.`,
  ]

  if (workspace.tools.length > 0) {
    lines.push(`Tools available: ${workspace.tools.map((tool) => tool.name).join(', ')}.`)
  }

  return lines.join('\n')
}

export function systemPreamble(workspace?: PreambleWorkspace): Rule {
  const text = preambleFor(workspace)

  return defineRule({
    name: 'systemPreamble',
    apply: (input) => ({
      system: [...input.system, { text }],
      messages: input.messages,
    }),
  })
}
