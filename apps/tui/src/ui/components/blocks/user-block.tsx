import React from 'react'

import { MarkdownView } from '../../markdown/markdown-view'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'

const GUTTER = 2

const PAD = 1

const RESERVED = GUTTER + PAD + TRANSCRIPT_INSET

const NARROWEST_BAND = 20

export function UserBlock(props: { text: string; width: number }): React.ReactNode {
  const columns = Math.max(NARROWEST_BAND, props.width - RESERVED)

  return (
    <box flexDirection="row" marginBottom={1} backgroundColor={theme.userBg} flexShrink={0}>
      <text fg={theme.userFg} bg={theme.userBg} flexShrink={0}>
        {glyph.user}{' '}
      </text>
      <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} paddingRight={PAD}>
        <MarkdownView source={props.text} width={columns} fg={theme.userFg} bg={theme.userBg} />
      </box>
    </box>
  )
}
