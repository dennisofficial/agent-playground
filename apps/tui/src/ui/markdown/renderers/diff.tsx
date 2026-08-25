import { createTextAttributes, type StyleDefinitionInput } from '@opentui/core'
import React from 'react'

import type { FencedBlockView, FencedRenderer } from '../registry'
import { codeTheme, type DiffPalette } from '../themes/index'

type DiffLineKind = keyof DiffPalette

const GIT_PREAMBLE =
  /^(diff |index |new file |deleted file |old mode|new mode|similarity |rename |Binary )/

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'removed'
  if (GIT_PREAMBLE.test(line)) return 'meta'
  return 'context'
}

function view(args: { source: string; width: number; palette: DiffPalette }): FencedBlockView {
  const lines = args.source.split('\n')
  const columns = Math.max(0, ...lines.map((line) => line.length))

  return {
    node: (
      <text wrapMode="none" width={Math.min(columns, args.width)} flexShrink={0}>
        {lines.map((line, index) => {
          const style: StyleDefinitionInput = args.palette[classifyDiffLine(line)]
          const text = style.bg ? line.padEnd(columns) : line
          return (
            <span
              key={index}
              {...(style.fg === undefined ? {} : { fg: style.fg })}
              {...(style.bg === undefined ? {} : { bg: style.bg })}
              attributes={createTextAttributes(style)}
            >
              {index === lines.length - 1 ? text : `${text}\n`}
            </span>
          )
        })}
      </text>
    ),
    columns,
    rows: lines.length,
  }
}

export const diffRenderer: FencedRenderer = {
  name: 'diff',
  handles: (language) => language === 'diff' || language === 'patch',
  render: (args) => view({ source: args.source, width: args.width, palette: codeTheme().diff }),
}
