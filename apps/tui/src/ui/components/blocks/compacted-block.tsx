import React from 'react'

import { useClickRegion } from '../../hooks/use-click-region'
import { MarkdownView } from '../../markdown/markdown-view'
import { theme, TRANSCRIPT_INSET } from '../../theme'

const NARROWEST_BAND = 24

const BODY_INDENT = 2

const HEADING = 'context compacted'

const RULE_CHARACTER = '─'

const OPEN_HINT = 'summary hidden'

const summarised = (count: number): string =>
  count === 1 ? '1 earlier entry summarised' : `${count} earlier entries summarised`

export function CompactedBlock(props: {
  text: string
  width: number
  compactedEntries: number
  expanded?: boolean
  onToggle?: () => void
}): React.ReactNode {
  const inner = Math.max(NARROWEST_BAND, props.width - TRANSCRIPT_INSET)
  const { handlers, hovered } = useClickRegion(props.onToggle)

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0} {...handlers}>
      <DividerRow
        inner={inner}
        compactedEntries={props.compactedEntries}
        expanded={props.expanded ?? false}
        hovered={hovered}
      />
      {props.expanded ?? false ? <Summary text={props.text} inner={inner} /> : null}
    </box>
  )
}

function DividerRow(props: {
  inner: number
  compactedEntries: number
  expanded: boolean
  hovered: boolean
}): React.ReactNode {
  const label = `${HEADING} · ${summarised(props.compactedEntries)}`
  const trailing = props.expanded ? '' : ` ${OPEN_HINT}`
  const rule = RULE_CHARACTER.repeat(
    Math.max(0, props.inner - label.length - trailing.length - 1),
  )

  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      <span fg={props.hovered ? theme.meta : theme.dim}>{`${label} ${rule}`}</span>
      {trailing === '' ? null : <span fg={theme.hint}>{trailing}</span>}
    </text>
  )
}

function Summary(props: { text: string; inner: number }): React.ReactNode {
  const band = Math.max(1, props.inner - BODY_INDENT)

  return (
    <>
      <text> </text>
      <box flexDirection="column" width={props.inner} flexShrink={0} paddingLeft={BODY_INDENT}>
        <MarkdownView source={props.text} width={band} fg={theme.meta} />
      </box>
    </>
  )
}
