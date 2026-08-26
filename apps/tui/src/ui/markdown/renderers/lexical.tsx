import { createTextAttributes } from '@opentui/core'
import React from 'react'

import { lexicalScannerFor } from '../lexical/registry'
import { styledRows, type StyledRows } from '../lexical/rows'
import type { FencedBlockView, FencedRenderArgs, FencedRenderer } from '../registry'
import { codeScopes, codeTheme, rolesFor } from '../themes/index'

function rowsFor(args: FencedRenderArgs): StyledRows | null {
  const scan = lexicalScannerFor(args.language)
  if (!scan) return null

  const theme = codeTheme()
  return styledRows({
    source: args.source,
    highlights: scan(args.source),
    scopes: codeScopes({ theme }),
    plain: rolesFor({ theme }).plain,
  })
}

function view(args: { rows: StyledRows; source: string; width: number }): FencedBlockView {
  const lines = args.source.split('\n')
  const columns = Math.max(0, ...lines.map((line) => line.length))

  return {
    node: (
      <text wrapMode="none" width={Math.min(columns, args.width)} flexShrink={0}>
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
    const rows = rowsFor(args)
    if (!rows) throw new Error(`no lexical language for "${args.language}"`)
    return view({ rows, source: args.source, width: args.width })
  },
}
