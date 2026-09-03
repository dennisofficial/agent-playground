import React from 'react'

import { ETldrStatus } from '@dltech/atlas-core'

import { useShimmerClock } from '../../hooks/use-shimmer-clock'
import { MarkdownView } from '../../markdown/markdown-view'
import { spinnerFrame, theme, TRANSCRIPT_INSET } from '../../theme'

const NARROWEST_BAND = 24

const BODY_INDENT = 2

const HEADING = 'tl;dr'

const GENERATING = 'tl;dr generating'

const RULE_CHARACTER = '─'

const STATUS_LABEL: Record<ETldrStatus, string> = {
  [ETldrStatus.Done]: 'done',
  [ETldrStatus.NeedsOperator]: 'needs you',
  [ETldrStatus.Waiting]: 'waiting',
}

export function TldrBlock(props: {
  text: string
  width: number
  status?: ETldrStatus | undefined
  streaming?: boolean | undefined
}): React.ReactNode {
  const streaming = props.streaming === true
  const now = useShimmerClock({ active: streaming })
  const inner = Math.max(NARROWEST_BAND, props.width - TRANSCRIPT_INSET)

  const generating = streaming && props.text.trim() === ''
  const status = props.status === undefined ? null : STATUS_LABEL[props.status]

  const heading = generating ? GENERATING : HEADING
  const chip = status === null ? '' : ` ${status} `
  const room = Math.max(0, inner - heading.length - chip.length - (generating ? 3 : 1))
  const before = Math.floor(room / 2)

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <text wrapMode="none" width={inner} flexShrink={0}>
        {generating ? <span fg={theme.accent}>{`${spinnerFrame(now)} `}</span> : null}
        <span fg={theme.dim}>{`${heading} `}</span>
        <span fg={theme.rule}>{RULE_CHARACTER.repeat(before)}</span>
        {status === null ? null : (
          <span
            bg={props.status === ETldrStatus.NeedsOperator ? theme.accent : theme.selectedBg}
            fg={props.status === ETldrStatus.NeedsOperator ? theme.caretFg : theme.meta}
          >
            {chip}
          </span>
        )}
        <span fg={theme.rule}>{RULE_CHARACTER.repeat(room - before)}</span>
      </text>
      {props.text.trim() === '' ? null : (
        <box flexDirection="column" width={inner} flexShrink={0} paddingLeft={BODY_INDENT}>
          <MarkdownView
            source={props.text}
            width={Math.max(1, inner - BODY_INDENT)}
            fg={theme.meta}
          />
        </box>
      )}
    </box>
  )
}

