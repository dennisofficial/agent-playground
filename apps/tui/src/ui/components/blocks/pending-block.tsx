import React from 'react'

import type { PendingMessage } from '../../../store'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'

const GUTTER = 2

const NARROWEST_BAND = 12

const ELLIPSIS = '…'

const TAKE_BACK = `${' '.repeat(GUTTER)}↑ to edit`

export function queuedLine(args: { text: string; columns: number }): string {
  const flattened = args.text.replace(/\s+/g, ' ').trim()
  const cells = [...flattened]
  if (cells.length <= args.columns) return flattened

  return `${cells.slice(0, Math.max(1, args.columns - 1)).join('')}${ELLIPSIS}`
}

export function PendingBlock(props: {
  messages: readonly PendingMessage[]
  width: number
}): React.ReactNode {
  if (props.messages.length === 0) return null

  const columns = Math.max(NARROWEST_BAND, props.width - TRANSCRIPT_INSET - GUTTER)

  return (
    <box flexDirection="column" marginTop={1} marginBottom={1} flexShrink={0}>
      {props.messages.map((message) => (
        <text key={message.id} fg={theme.meta}>
          <span fg={theme.court.yours}>{glyph.queued}</span>{' '}
          {queuedLine({ text: message.text, columns })}
        </text>
      ))}
      <text fg={theme.hint}>{TAKE_BACK}</text>
    </box>
  )
}
