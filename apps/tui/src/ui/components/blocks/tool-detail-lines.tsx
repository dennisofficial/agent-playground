import React from 'react'

import { stripAnsi } from '../../ansi'
import { tailOfPath } from '../../paths'

const DETAIL_INDENT = '    '

export const detailLine = (args: { text: string; inner: number }): string =>
  `${DETAIL_INDENT}${tailOfPath({ path: stripAnsi(args.text), cells: Math.max(8, args.inner - DETAIL_INDENT.length) })}`

export type LineGroup = { fg: string; lines: readonly string[] }

/**
 * A block of same-shaped rows as ONE <text> with a span per colour group — the rows a per-line
 * loop used to spend a renderable each on. Every renderable still mounted is repainted every
 * frame, so a twelve-row detail is one repaint here, not twelve.
 */
export function JoinedLines(props: { inner: number; groups: readonly LineGroup[] }): React.ReactNode {
  const groups = props.groups.filter((group) => group.lines.length > 0)
  if (groups.length === 0) return null

  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      {groups.flatMap((group, index) => {
        const span = (
          <span key={index} fg={group.fg}>
            {group.lines.join('\n')}
          </span>
        )
        return index === 0 ? [span] : ['\n', span]
      })}
    </text>
  )
}

