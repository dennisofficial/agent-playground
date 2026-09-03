import type { SaidImage } from '@dltech/atlas-core'
import React from 'react'

import { MarkdownView } from '../../markdown/markdown-view'
import { saidImageLine } from '../../said-images'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from '../panel'

const RESERVED = PANEL_INSET + PANEL_PAD + TRANSCRIPT_INSET

const NARROWEST_BAND = 20

const TAKE_BACK = '↑ to edit'

const skillLine = (skills: readonly string[]): string =>
  `${glyph.result} ${skills.length === 1 ? 'skill' : 'skills'} ${skills.join(', ')}`

const fileLine = (files: readonly string[]): string =>
  `${glyph.result} ${files.length === 1 ? 'file' : 'files'} ${files.join(', ')}`

export function UserBlock(props: {
  said: readonly string[]
  width: number
  takeBack?: boolean
  skills?: readonly string[]
  files?: readonly string[]
  images?: readonly SaidImage[]
}): React.ReactNode {
  const columns = Math.max(NARROWEST_BAND, props.width - RESERVED)
  const skills = props.skills ?? []
  const files = props.files ?? []
  const images = props.images ?? []

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Panel
        rail={theme.court.yours}
        fill={theme.userBg}
        width={props.width - TRANSCRIPT_INSET}
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
      {files.length === 0 ? null : (
        <box paddingLeft={PANEL_PAD}>
          <text fg={theme.meta}>{fileLine(files)}</text>
        </box>
      )}
      {images.map((image) => (
        <box key={image.path} paddingLeft={PANEL_PAD}>
          <text fg={theme.meta}>{saidImageLine(image)}</text>
        </box>
      ))}
    </box>
  )
}
