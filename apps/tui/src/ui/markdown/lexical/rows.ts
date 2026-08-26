import type { StyleDefinitionInput } from '@opentui/core'

import type { LexHighlight } from './spec'

export type StyledRun = {
  readonly text: string
  readonly style: StyleDefinitionInput
}

export type StyledRows = readonly (readonly StyledRun[])[]

/**
 * OpenTUI's own scope resolution (`SyntaxStyle.getStyle`) falls back exactly one level, to the text
 * before the FIRST dot — `function.call` reaches `function`, `markup.link.url` never reaches `markup`.
 * Emitted groups are matched the same way so a lexical language and a tree-sitter one colour alike.
 */
export function styleForGroup(args: {
  group: string
  scopes: Readonly<Record<string, StyleDefinitionInput>>
  plain: StyleDefinitionInput
}): StyleDefinitionInput {
  const exact = args.scopes[args.group]
  if (exact) return exact

  const dot = args.group.indexOf('.')
  if (dot === -1) return args.plain

  return args.scopes[args.group.slice(0, dot)] ?? args.plain
}

export function styledRows(args: {
  source: string
  highlights: readonly LexHighlight[]
  scopes: Readonly<Record<string, StyleDefinitionInput>>
  plain: StyleDefinitionInput
}): StyledRows {
  const rows: StyledRun[][] = [[]]
  let cursor = 0

  const push = (args2: { text: string; style: StyleDefinitionInput }): void => {
    if (args2.text.length === 0) return
    const parts = args2.text.split('\n')
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) rows.push([])
      const text = parts[index] ?? ''
      if (text.length === 0) continue
      rows.at(-1)?.push({ text, style: args2.style })
    }
  }

  for (const [start, end, group] of args.highlights) {
    if (start < cursor || end <= start) continue
    push({ text: args.source.slice(cursor, start), style: args.plain })
    push({
      text: args.source.slice(start, end),
      style: styleForGroup({ group, scopes: args.scopes, plain: args.plain }),
    })
    cursor = end
  }

  push({ text: args.source.slice(cursor), style: args.plain })

  return rows
}
