import React from 'react'

import { theme, TRANSCRIPT_INSET } from '../../theme'

const HEADING = 'context compacted'

const RULE_CHARACTER = '─'

const summaryOf = (count: number): string =>
  count === 1 ? '1 earlier entry summarised' : `${count} earlier entries summarised`

export function CompactedBlock(props: {
  text: string
  width: number
  compactedEntries: number
}): React.ReactNode {
  const width = Math.max(1, props.width - TRANSCRIPT_INSET)
  const label = `${HEADING} · ${summaryOf(props.compactedEntries)}`
  const rule = RULE_CHARACTER.repeat(Math.max(0, width - label.length - 1))

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <text fg={theme.dim}>{`${label} ${rule}`}</text>
      <text fg={theme.meta}>{props.text}</text>
    </box>
  )
}
