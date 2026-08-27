import React from 'react'

import { useClickRegion } from '../../hooks/use-click-region'
import { wrapWords } from '../../text-flow'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'

const NARROWEST_BAND = 24

const BODY_INDENT = 2

const PRINTED_NOTHING = 'printed nothing'

const OPEN_HINT = '↵ output'

export function ShellEndedBlock(props: {
  text: string
  output: string
  failed: boolean
  width: number
  expanded?: boolean
  onToggle?: () => void
}): React.ReactNode {
  const inner = Math.max(NARROWEST_BAND, props.width - TRANSCRIPT_INSET)
  const printed = props.output.trimEnd()
  const { handlers, hovered } = useClickRegion(printed === '' ? undefined : props.onToggle)

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0} {...handlers}>
      <HeadingRow
        text={props.text}
        failed={props.failed}
        inner={inner}
        hovered={hovered}
        affordance={printed !== '' && props.expanded !== true}
      />
      {printed === '' ? (
        <BodyRow text={PRINTED_NOTHING} inner={inner} />
      ) : props.expanded === true ? (
        <Printed text={printed} inner={inner} />
      ) : null}
    </box>
  )
}

function HeadingRow(props: {
  text: string
  failed: boolean
  inner: number
  hovered: boolean
  affordance: boolean
}): React.ReactNode {
  const mark = props.failed ? theme.error : theme.ok

  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      <span fg={mark}>{`${glyph.block} `}</span>
      <span fg={props.hovered ? theme.hover : theme.meta}>{props.text}</span>
      {props.affordance ? <span fg={theme.dim}>{`  ${OPEN_HINT}`}</span> : null}
    </text>
  )
}

function Printed(props: { text: string; inner: number }): React.ReactNode {
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
