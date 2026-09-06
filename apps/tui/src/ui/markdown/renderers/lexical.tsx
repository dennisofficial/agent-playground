import { createTextAttributes } from '@opentui/core'
import React from 'react'

import { lexicalScannerFor } from '../lexical/registry'
import { styledRows, type StyledRows } from '../lexical/rows'
import type { FencedBlockView, FencedRenderArgs, FencedRenderer } from '../registry'
import { codeScopes, codeTheme, type CodeTheme, rolesFor } from '../themes/index'

const CACHE_LIMIT = 128

const rowsByTheme = new WeakMap<CodeTheme, Map<string, StyledRows>>()

export function lexicalRows(args: { source: string; language: string }): StyledRows | null {
  const scan = lexicalScannerFor(args.language)
  if (!scan) return null

  const theme = codeTheme()
  const cache = rowsByTheme.get(theme) ?? new Map<string, StyledRows>()
  rowsByTheme.set(theme, cache)

  const key = `${args.language}\0${args.source}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const rows = styledRows({
    source: args.source,
    highlights: scan(args.source),
    scopes: codeScopes({ theme }),
    plain: rolesFor({ theme }).plain,
  })
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, rows)
  return rows
}

function view(args: {
  rows: StyledRows
  source: string
  width: number
  wrap: boolean
}): FencedBlockView {
  const lines = args.source.split('\n')
  const columns = Math.max(0, ...lines.map((line) => line.length))

  return {
    node: (
      <text
        wrapMode={args.wrap ? 'word' : 'none'}
        width={Math.min(columns, args.width)}
        flexShrink={0}
      >
        {args.rows.map((runs, row) => (
          <span key={row}>
            {runs.map((run, index) => (
              <span
                key={index}
                {...(run.style.fg === undefined ? {} : { fg: run.style.fg })}
                {...(run.style.bg === undefined ? {} : { bg: run.style.bg })}
                attributes={createTextAttributes(run.style)}
              >
                {run.text}
              </span>
            ))}
            {row === args.rows.length - 1 ? '' : '\n'}
          </span>
        ))}
      </text>
    ),
    columns,
    rows: lines.length,
  }
}

export const lexicalRenderer: FencedRenderer = {
  name: 'lexical',
  handles: (language) => lexicalScannerFor(language) !== null,
  render: (args) => {
    const rows = lexicalRows({ source: args.source, language: args.language })
    if (!rows) throw new Error(`no lexical language for "${args.language}"`)
    return view({ rows, source: args.source, width: args.width, wrap: args.wrap })
  },
}
