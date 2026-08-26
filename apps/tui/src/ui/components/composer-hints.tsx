import React from 'react'

import { cellsOf, fitHints, hintSpans, hintWidth, type Hint } from '../hint-layout'
import { theme } from '../theme'
import { Spans } from './spans'

export type { Hint }

/** Lines the row up under the draft text: one column of rail, then the panel's own padding. */
const GUTTER = 3

const GAP = 2

/**
 * Where you are on the left, what you can press on the right — the composer's own row of chrome,
 * drawn on the terminal's background so the panel above it reads as the thing you are typing into.
 */
export function ComposerHints(props: {
  width: number
  hints: readonly Hint[]
  status?: string
  keyColour?: string
}): React.ReactNode {
  const inner = Math.max(0, props.width - GUTTER * 2)
  const status = props.status ?? ''
  const claimed = status.length === 0 ? 0 : cellsOf(status) + GAP
  const hints = fitHints({ hints: props.hints, cells: inner - claimed })
  const pad = inner - hintWidth(hints) - cellsOf(status)
  const led = status.length > 0 && pad >= GAP ? status : ''

  return (
    <box flexDirection="row" flexShrink={0} paddingLeft={GUTTER} paddingRight={GUTTER}>
      <text>
        {led.length > 0 ? (
          <>
            <span fg={theme.hint}>{led}</span>
            <span>{' '.repeat(pad)}</span>
          </>
        ) : null}
        <Spans spans={hintSpans({ hints, keyColour: props.keyColour ?? theme.meta })} />
      </text>
    </box>
  )
}
