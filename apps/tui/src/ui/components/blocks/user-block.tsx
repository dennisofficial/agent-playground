import type { SaidImage } from '@dltech/atlas-core'
import React from 'react'

import { MarkdownView } from '../../markdown/markdown-view'
import { saidImageText } from '../../said-images'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from '../panel'

const RESERVED = PANEL_INSET + PANEL_PAD + TRANSCRIPT_INSET

const NARROWEST_BAND = 20

const TAKE_BACK = '↑ to edit'

const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

type AttachmentChip = { key: string; icon: string; label: string }

function attachmentChips(args: {
  skills: readonly string[]
  files: readonly string[]
  images: readonly SaidImage[]
}): readonly AttachmentChip[] {
  return [
    ...args.skills.map((skill) => ({ key: `skill:${skill}`, icon: glyph.skill, label: skill })),
    ...args.files.map((file) => ({ key: `file:${file}`, icon: glyph.file, label: basename(file) })),
    ...args.images.map((image) => ({
      key: `image:${image.path}`,
      icon: glyph.image,
      label: saidImageText(image),
    })),
  ]
}

function Chip(props: { chip: AttachmentChip }): React.ReactNode {
  return (
    <box backgroundColor={theme.selectedBg} flexShrink={0}>
      <text fg={theme.body}>{` ${props.chip.icon} ${props.chip.label} `}</text>
    </box>
  )
}

/**
 * What the message carried rides inside the slab: a footer band seamed onto a darker ground, each
 * attachment a raised chip so a skill, a file and an image read as the same kind of thing.
 */
export function UserBlock(props: {
  said: readonly string[]
  width: number
  takeBack?: boolean
  skills?: readonly string[]
  files?: readonly string[]
  images?: readonly SaidImage[]
}): React.ReactNode {
  const columns = Math.max(NARROWEST_BAND, props.width - RESERVED)
  const chips = attachmentChips({
    skills: props.skills ?? [],
    files: props.files ?? [],
    images: props.images ?? [],
  })

  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Panel
        rail={theme.court.yours}
        fill={theme.userBg}
        band={theme.userBand}
        width={props.width - TRANSCRIPT_INSET}
        {...(props.takeBack === true
          ? {
              badge: (
                <text fg={theme.hint} bg={theme.userBg}>{` ${TAKE_BACK} `}</text>
              ),
            }
          : {})}
        {...(chips.length === 0
          ? {}
          : {
              footer: (
                <box flexDirection="row" flexWrap="wrap" gap={1} flexShrink={0}>
                  {chips.map((chip) => (
                    <Chip key={chip.key} chip={chip} />
                  ))}
                </box>
              ),
            })}
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
