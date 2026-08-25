import { infoStringToFiletype } from '@opentui/core'
import React from 'react'

import type { FencedBlockView, FencedRenderArgs, FencedRenderer } from '../registry'
import { codeSyntaxStyleFor } from '../syntax-style'

function highlightedView(args: FencedRenderArgs): FencedBlockView {
  const lines = args.source.split('\n')
  const filetype = infoStringToFiletype(args.language) ?? args.language
  const columns = Math.max(0, ...lines.map((line) => line.length))

  return {
    node: (
      <code
        content={args.source}
        filetype={filetype}
        syntaxStyle={codeSyntaxStyleFor(filetype)}
        wrapMode="none"
        width={Math.min(columns, args.width)}
        flexShrink={0}
      />
    ),
    columns,
    rows: lines.length,
  }
}

export const codeRenderer: FencedRenderer = {
  name: 'code',
  handles: (language) => language.length > 0,
  render: highlightedView,
}

export const plainRenderer: FencedRenderer = {
  name: 'plain',
  handles: () => true,
  render: (args) => {
    const lines = args.source.split('\n')
    const columns = Math.max(0, ...lines.map((line) => line.length))
    return {
      node: (
        <text wrapMode="none" width={Math.min(columns, args.width)} flexShrink={0}>
          {args.source}
        </text>
      ),
      columns,
      rows: lines.length,
    }
  },
}
