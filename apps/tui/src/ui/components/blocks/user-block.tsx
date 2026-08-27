import React from 'react'

import { MarkdownView } from '../../markdown/markdown-view'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from '../panel'

const RESERVED = PANEL_INSET + PANEL_PAD + TRANSCRIPT_INSET

const NARROWEST_BAND = 20

export enum EUserMark {
  Plain = 'plain',
  MidTurn = 'mid-turn',
}

const MARK_TEXT: Record<EUserMark, string | null> = {
  [EUserMark.Plain]: null,
  [EUserMark.MidTurn]: `${glyph.queued} sent mid-turn`,
}

const TAKE_BACK = '↑ to edit'

export function UserBlock(props: {
  said: readonly string[]
  width: number
  mark?: EUserMark
  takeBack?: boolean
}): React.ReactNode {
  const columns = Math.max(NARROWEST_BAND, props.width - RESERVED)
  const mark = MARK_TEXT[props.mark ?? EUserMark.Plain]

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Panel
        rail={theme.court.yours}
        fill={theme.userBg}
        width={props.width - TRANSCRIPT_INSET}
        {...(mark === null
          ? {}
          : {
              label: (
                <text fg={theme.meta} bg={theme.userBg}>{` ${mark} `}</text>
              ),
            })}
        {...(props.takeBack === true
          ? {
              badge: (
                <text fg={theme.hint} bg={theme.userBg}>{` ${TAKE_BACK} `}</text>
              ),
            }
          : {})}
      >
        {props.said.map((text, index) => (
          <MarkdownView
            key={`${index}:${text}`}
            source={text}
            width={columns}
            fg={theme.userFg}
            bg={theme.userBg}
          />
        ))}
      </Panel>
    </box>
  )
}
