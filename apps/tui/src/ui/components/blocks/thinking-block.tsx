import React from 'react'

import { useClickRegion } from '../../hooks/use-click-region'
import { MarkdownView } from '../../markdown/markdown-view'
import { tail, THINKING_TAIL_LINES, thinkingSummary, wrapWords } from '../../text-flow'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'

const NARROWEST_BAND = 24

const BODY_INDENT = 2

type Wash = { bg?: string }

export function ThinkingBlock(props: {
  text: string
  width: number
  streaming?: boolean
  expanded?: boolean
  onToggle?: () => void
  interrupted?: boolean
}): React.ReactNode {
  const inner = Math.max(NARROWEST_BAND, props.width - TRANSCRIPT_INSET)
  const { handlers, wash } = useClickRegion(props.streaming ? undefined : props.onToggle)

  return (
    <box flexDirection="column" marginBottom={1} {...handlers}>
      {props.streaming ? (
        <LiveTail text={props.text} inner={inner} wash={wash} />
      ) : props.expanded ? (
        <OpenedDocument text={props.text} inner={inner} wash={wash} />
      ) : (
        <HeaderRow label={`${glyph.thinking} ${thinkingSummary(props.text)}`} inner={inner} wash={wash} />
      )}
      {props.interrupted ? <text fg={theme.dim}> Interrupted by user</text> : null}
    </box>
  )
}

function HeaderRow(props: { label: string; inner: number; wash: Wash }): React.ReactNode {
  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      <span fg={theme.dim} {...props.wash}>
        {props.label}
      </span>
      <span {...props.wash}>{fill(props.inner, props.label.length)}</span>
    </text>
  )
}

function OpenedDocument(props: { text: string; inner: number; wash: Wash }): React.ReactNode {
  const band = Math.max(NARROWEST_BAND - BODY_INDENT, props.inner - BODY_INDENT)
  return (
    <>
      <HeaderRow label={`${glyph.thinking} Thinking…`} inner={props.inner} wash={props.wash} />
      <text> </text>
      <box
        flexDirection="column"
        width={props.inner}
        flexShrink={0}
        paddingLeft={BODY_INDENT}
        {...(props.wash.bg === undefined ? {} : { backgroundColor: props.wash.bg })}
      >
        <MarkdownView source={props.text} width={band} fg={theme.dim} {...props.wash} />
      </box>
    </>
  )
}

/**
 * The live block tails rather than growing a row per token: reasoning runs for pages and would walk
 * the working line off the bottom of the screen. It keeps hand-wrapped rows where the finished block
 * renders markdown, because a document sliced at the top is not one.
 */
function LiveTail(props: { text: string; inner: number; wash: Wash }): React.ReactNode {
  const band = Math.max(NARROWEST_BAND - BODY_INDENT, props.inner - BODY_INDENT)
  const rows = props.text.split('\n').flatMap((line) => wrapWords(line, band))
  const view = tail(rows, THINKING_TAIL_LINES)

  return (
    <>
      <HeaderRow label={`${glyph.thinking} Thinking…`} inner={props.inner} wash={props.wash} />
      <text> </text>
      {view.notice === null ? null : (
        <BodyRow text={view.notice} inner={props.inner} wash={props.wash} />
      )}
      {view.shown.map((row, index) => (
        <BodyRow
          key={index}
          text={row}
          inner={props.inner}
          wash={props.wash}
          caret={index === view.shown.length - 1}
        />
      ))}
    </>
  )
}

function BodyRow(props: {
  text: string
  inner: number
  wash: Wash
  caret?: boolean
}): React.ReactNode {
  const indent = ' '.repeat(BODY_INDENT)
  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      <span fg={theme.dim} {...props.wash}>
        {indent}
        {props.text}
      </span>
      <span {...props.wash}>{fill(props.inner, BODY_INDENT + props.text.length)}</span>
      {props.caret ? <span>{glyph.caret}</span> : null}
    </text>
  )
}

function fill(inner: number, used: number): string {
  return ' '.repeat(Math.max(0, inner - used))
}
