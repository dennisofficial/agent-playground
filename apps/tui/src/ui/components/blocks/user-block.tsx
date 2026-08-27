import React from 'react'

import { MarkdownView } from '../../markdown/markdown-view'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from '../panel'

const RESERVED = PANEL_INSET + PANEL_PAD + TRANSCRIPT_INSET

const NARROWEST_BAND = 20

const MID_TURN = `${glyph.queued} sent mid-turn`

export function UserBlock(props: {
  text: string
  width: number
  steer?: boolean
}): React.ReactNode {
  const columns = Math.max(NARROWEST_BAND, props.width - RESERVED)

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Panel
        rail={theme.court.yours}
        fill={theme.userBg}
        width={props.width - TRANSCRIPT_INSET}
        {...(props.steer === true
          ? { label: <text fg={theme.meta} bg={theme.userBg}>{` ${MID_TURN} `}</text> }
          : {})}
      >
        <MarkdownView source={props.text} width={columns} fg={theme.userFg} bg={theme.userBg} />
      </Panel>
    </box>
  )
}
