import { infoStringToFiletype } from '@opentui/core'
import React from 'react'

import type { FencedBlockView, FencedRenderArgs, FencedRenderer } from '../registry'
import { codeSyntaxStyleFor } from '../syntax-style'
import { cachingTreeSitterClient } from './highlight-client'

function highlightedView(args: FencedRenderArgs): FencedBlockView {
  const lines = args.source.split('\n')
  const filetype = infoStringToFiletype(args.language) ?? args.language
  const columns = Math.max(0, ...lines.map((line) => line.length))

  return {
    node: (
      // A CodeRenderable clears itself to plain text the instant `content` changes and only paints
      // the highlight a round trip later, which reads as a flash on every keystroke of a streamed
      // block. `streaming` with `drawUnstyledText` off takes the branch that leaves the previous
      // styled buffer up until the new highlight lands instead — at the cost of drawing nothing at
      // all until the FIRST highlight lands, which is why settled blocks keep the default.
      // @opentui/core 0.4.5 assigns element properties in JSX attribute order, so both must be
      // declared before `content`.
      <code
        streaming={args.streaming}
        drawUnstyledText={!args.streaming}
        treeSitterClient={cachingTreeSitterClient()}
        content={args.source}
        filetype={filetype}
        syntaxStyle={codeSyntaxStyleFor(filetype)}
        wrapMode={args.wrap ? 'word' : 'none'}
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
        <text
          wrapMode={args.wrap ? 'word' : 'none'}
          width={Math.min(columns, args.width)}
          flexShrink={0}
        >
          {args.source}
        </text>
      ),
      columns,
      rows: lines.length,
    }
  },
}
