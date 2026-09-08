import React from 'react'

import { EContextSlot } from '@dltech/atlas-core'

import type { ContextAttachment, ToolCall } from '../../../store'
import { relativise } from '../../../store/tools'
import { useClickRegion } from '../../hooks/use-click-region'
import { tailOfPath } from '../../paths'
import { wrapWords } from '../../text-flow'
import { glyph, theme } from '../../theme'
import { contextKey } from './tool-run-expansion'

const INDENT = '  '

const BODY_INDENT = '      '

const labelOf = (args: { attachment: ContextAttachment; cwd: string }): string =>
  args.attachment.slot === EContextSlot.NestedInstructions
    ? relativise(args.attachment.name, args.cwd)
    : args.attachment.slot

export function Attachments(props: {
  calls: readonly ToolCall[]
  inner: number
  cwd: string
  opened: ReadonlySet<string>
  onToggle: (key: string) => void
}): React.ReactNode {
  const attachments = props.calls.flatMap((call) => call.attachments)
  if (attachments.length === 0) return null

  return (
    <>
      {attachments.map((attachment) => (
        <AttachmentRow
          key={attachment.id}
          attachment={attachment}
          inner={props.inner}
          cwd={props.cwd}
          opened={props.opened}
          onToggle={props.onToggle}
        />
      ))}
    </>
  )
}

function AttachmentRow(props: {
  attachment: ContextAttachment
  inner: number
  cwd: string
  opened: ReadonlySet<string>
  onToggle: (key: string) => void
}): React.ReactNode {
  const { attachment } = props
  const key = contextKey(attachment.id)
  const region = useClickRegion(() => props.onToggle(key))
  const label = tailOfPath({
    path: labelOf({ attachment, cwd: props.cwd }),
    cells: Math.max(8, props.inner - INDENT.length - 2),
  })

  return (
    <box flexDirection="column" flexShrink={0}>
      <text wrapMode="none" width={props.inner} flexShrink={0} {...region.handlers}>
        <span fg={theme.rule} {...region.wash}>{`${INDENT}${glyph.result} `}</span>
        <span fg={region.hovered ? theme.hover : theme.hint} {...region.wash}>
          {label}
        </span>
      </text>
      {props.opened.has(key) ? <Body text={attachment.content} inner={props.inner} /> : null}
    </box>
  )
}

function Body(props: { text: string; inner: number }): React.ReactNode {
  const band = Math.max(1, props.inner - BODY_INDENT.length)
  const rows = props.text
    .trimEnd()
    .split('\n')
    .flatMap((line) => wrapWords({ text: line, width: band }))

  return (
    <>
      {rows.map((row, index) => (
        <text key={index} wrapMode="none" width={props.inner} flexShrink={0}>
          <span fg={theme.hint}>{`${BODY_INDENT}${row}`}</span>
        </text>
      ))}
    </>
  )
}
