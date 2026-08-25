import React from 'react'

import { MarkdownView } from '../../markdown/markdown-view'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'

const GUTTER = 2

const RESERVED = GUTTER + TRANSCRIPT_INSET

export function AssistantBlock(props: {
  text: string
  width: number
  streaming?: boolean
  interrupted?: boolean
}): React.ReactNode {
  return (
    <box flexDirection="column" marginBottom={1}>
      <box flexDirection="row">
        <text fg={theme.accent}>{glyph.block} </text>
        <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
          <MarkdownView
            source={props.text}
            width={Math.max(1, props.width - RESERVED)}
            {...(props.streaming === undefined ? {} : { streaming: props.streaming })}
          />
        </box>
      </box>
      {props.interrupted ? <text fg={theme.dim}> Interrupted by user</text> : null}
    </box>
  )
}
