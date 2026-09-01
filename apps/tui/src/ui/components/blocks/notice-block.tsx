import React from 'react'

import { useClickRegion } from '../../hooks/use-click-region'
import { wrapWords } from '../../text-flow'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'

const NARROWEST_BAND = 24

const BODY_INDENT = 2

export function NoticeBlock(props: {
  text: string
  body: string
  failed: boolean
  width: number
  openHint: string
  silentNote: string
  expanded?: boolean
  onToggle?: () => void
}): React.ReactNode {
  const inner = Math.max(NARROWEST_BAND, props.width - TRANSCRIPT_INSET)
  const body = props.body.trimEnd()
  const { handlers, hovered } = useClickRegion(body === '' ? undefined : props.onToggle)

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0} {...handlers}>
      <HeadingRow
        text={props.text}
        failed={props.failed}
        inner={inner}
        hovered={hovered}
        hint={props.openHint}
        affordance={body !== '' && props.expanded !== true}
      />
      {body === '' ? (
        <BodyRow text={props.silentNote} inner={inner} />
      ) : props.expanded === true ? (
        <Body text={body} inner={inner} />
      ) : null}
    </box>
  )
}

function HeadingRow(props: {
  text: string
  failed: boolean
  inner: number
  hovered: boolean
  hint: string
  affordance: boolean
}): React.ReactNode {
  const mark = props.failed ? theme.error : theme.ok

  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      <span fg={mark}>{`${glyph.block} `}</span>
      <span fg={props.hovered ? theme.hover : theme.meta}>{props.text}</span>
      {props.affordance ? <span fg={theme.dim}>{`  ${props.hint}`}</span> : null}
    </text>
  )
}

function Body(props: { text: string; inner: number }): React.ReactNode {
  const band = Math.max(1, props.inner - BODY_INDENT)
  const rows = props.text.split('\n').flatMap((line) => wrapWords({ text: line, width: band }))

  return (
    <>
      {rows.map((row, index) => (
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
