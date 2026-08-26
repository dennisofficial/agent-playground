import React from 'react'

import { useClickRegion } from '../../hooks/use-click-region'
import { MarkdownView } from '../../markdown/markdown-view'
import { tail, THINKING_TAIL_LINES, thinkingSummary, wrapWords } from '../../text-flow'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'

const NARROWEST_BAND = 24

const BODY_INDENT = 2

const INTERRUPTED = 'Interrupted by you'

export function ThinkingBlock(props: {
  text: string
  width: number
  streaming?: boolean
  expanded?: boolean
  onToggle?: () => void
  interrupted?: boolean
}): React.ReactNode {
  const inner = Math.max(NARROWEST_BAND, props.width - TRANSCRIPT_INSET)
  const { handlers, hovered } = useClickRegion(props.streaming ? undefined : props.onToggle)

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0} {...handlers}>
      {props.streaming ? (
        <LiveTail text={props.text} inner={inner} />
      ) : props.expanded ? (
        <OpenedDocument text={props.text} inner={inner} />
      ) : (
        <CollapsedRow text={props.text} inner={inner} hovered={hovered} />
      )}
      {props.interrupted ? <text fg={theme.hint}>{`  ${INTERRUPTED}`}</text> : null}
    </box>
  )
}

function CollapsedRow(props: { text: string; inner: number; hovered: boolean }): React.ReactNode {
  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      <span fg={props.hovered ? theme.meta : theme.hint}>
        {`${glyph.thinking} ${thinkingSummary(props.text)}`}
      </span>
    </text>
  )
}

function HeaderRow(props: { inner: number }): React.ReactNode {
  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      <span fg={theme.hint}>{`${glyph.thinking} Thinking…`}</span>
    </text>
  )
}

function OpenedDocument(props: { text: string; inner: number }): React.ReactNode {
  const band = Math.max(1, props.inner - BODY_INDENT)

  return (
    <>
      <HeaderRow inner={props.inner} />
      <text> </text>
      <box
        flexDirection="column"
        width={props.inner}
        flexShrink={0}
        paddingLeft={BODY_INDENT}
      >
        <MarkdownView source={props.text} width={band} fg={theme.hint} />
      </box>
    </>
  )
}

function LiveTail(props: { text: string; inner: number }): React.ReactNode {
  const band = Math.max(1, props.inner - BODY_INDENT)
  const rows = props.text.split('\n').flatMap((line) => wrapWords({ text: line, width: band }))
  const view = tail({ items: rows, limit: THINKING_TAIL_LINES })

  return (
    <>
      <HeaderRow inner={props.inner} />
      <text> </text>
      {view.notice === null ? null : <BodyRow text={view.notice} inner={props.inner} />}
      {view.shown.map((row, index) => (
        <BodyRow key={index} text={row} inner={props.inner} />
      ))}
    </>
  )
}

function BodyRow(props: { text: string; inner: number }): React.ReactNode {
  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      <span fg={theme.hint}>
        {' '.repeat(BODY_INDENT)}
        {props.text}
      </span>
    </text>
  )
}
