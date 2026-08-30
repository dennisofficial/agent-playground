import React from 'react'

import { MarkdownView } from '../../markdown/markdown-view'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'

const MARK_COLUMNS = 2

const RESERVED = MARK_COLUMNS + TRANSCRIPT_INSET

const INTERRUPTED = 'Interrupted by you'

export function AssistantBlock(props: {
  text: string
  width: number
  streaming?: boolean
  interrupted?: boolean
}): React.ReactNode {
  return (
    // Always a blank row underneath, including when a tool run follows. The reply used to hug the
    // group it asked for, which was right when a group drew one attached summary line and wrong now
    // that a run draws a stack of rows: the prose ended up touching the first of them.
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <box flexDirection="row">
        <text fg={theme.accent} flexShrink={0}>
          {`${glyph.block} `}
        </text>
        <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
          <MarkdownView
            source={props.text}
            width={Math.max(1, props.width - RESERVED)}
            {...(props.streaming === undefined ? {} : { streaming: props.streaming })}
          />
        </box>
      </box>
      {props.interrupted ? <text fg={theme.hint}>{`  ${INTERRUPTED}`}</text> : null}
    </box>
  )
}
