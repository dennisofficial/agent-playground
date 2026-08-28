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

const skillLine = (skills: readonly string[]): string =>
  `${glyph.result} ${skills.length === 1 ? 'skill' : 'skills'} ${skills.join(', ')}`

export function UserBlock(props: {
  said: readonly string[]
  width: number
  mark?: EUserMark
  takeBack?: boolean
  skills?: readonly string[]
}): React.ReactNode {
  const columns = Math.max(NARROWEST_BAND, props.width - RESERVED)
  const mark = MARK_TEXT[props.mark ?? EUserMark.Plain]
  const skills = props.skills ?? []

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
      {skills.length === 0 ? null : (
        <box paddingLeft={PANEL_PAD}>
          <text fg={theme.meta}>{skillLine(skills)}</text>
        </box>
      )}
    </box>
  )
}
