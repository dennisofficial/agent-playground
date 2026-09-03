import React, { useSyncExternalStore } from 'react'

import { currentNotices, ENoticeTone, noticeVersion, subscribeNotices } from '../notice-store'
import { glyph, theme, TRANSCRIPT_INSET } from '../theme'
import { truncateCells } from './sidebar/cells'

export const NOTICE_MIN_CELLS = 8

const SLAB_PAD = 2

const toneInk = (tone: ENoticeTone): string => {
  if (tone === ENoticeTone.Warn) return theme.warn
  if (tone === ENoticeTone.Info) return theme.hover
  return theme.meta
}

const toneMark = (tone: ENoticeTone): string => {
  if (tone === ENoticeTone.Warn) return glyph.warning
  if (tone === ENoticeTone.Info) return glyph.marker
  return glyph.passed
}

/**
 * Floats over the bottom of the transcript rather than taking a row: a toast that pushed the
 * composer down and sprang back a second later would move the text the operator is reading
 * twice per notice. Opaque because it is drawn over live text, like the jump-to-bottom pill.
 */
export function NoticeStack(props: { width: number }): React.ReactNode {
  useSyncExternalStore(subscribeNotices, noticeVersion)
  const notices = currentNotices()
  if (notices.length === 0 || props.width < NOTICE_MIN_CELLS) return null

  const cells = props.width - TRANSCRIPT_INSET

  return (
    <box position="absolute" bottom={0} right={0} flexDirection="column" alignItems="flex-end">
      {notices.map((notice) => (
        <box
          key={notice.key}
          flexDirection="row"
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.overlayBg}
        >
          <text fg={toneInk(notice.tone)} bg={theme.overlayBg}>
            {`${toneMark(notice.tone)} ${truncateCells({ text: notice.text, cells: cells - SLAB_PAD })} `}
          </text>
        </box>
      ))}
    </box>
  )
}
