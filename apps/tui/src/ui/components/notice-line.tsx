import React, { useSyncExternalStore } from 'react'

import { currentNotice, ENoticeTone, noticeVersion, subscribeNotices } from '../notice-store'
import { theme } from '../theme'
import { truncateCells } from './sidebar/cells'

export const NOTICE_ROWS = 1

const NOTICE_GUTTER = 3

const inkOf = (tone: ENoticeTone): string =>
  tone === ENoticeTone.Warn ? theme.warn : theme.meta

export function NoticeLine(props: { width: number }): React.ReactNode {
  useSyncExternalStore(subscribeNotices, noticeVersion)
  const notice = currentNotice()

  return (
    <box height={NOTICE_ROWS} flexShrink={0} paddingLeft={NOTICE_GUTTER}>
      {notice === null ? null : (
        <text fg={inkOf(notice.tone)}>
          {truncateCells({
            text: notice.text,
            cells: Math.max(0, props.width - NOTICE_GUTTER),
          })}
        </text>
      )}
    </box>
  )
}
