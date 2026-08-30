import React, { useSyncExternalStore } from 'react'

import { currentNotice, ENoticeTone, noticeVersion, subscribeNotices } from '../notice-store'
import { theme } from '../theme'
import { truncateCells } from './sidebar/cells'

export const NOTICE_MIN_CELLS = 8

const SLAB_PAD = 1

const inkOf = (tone: ENoticeTone): string => (tone === ENoticeTone.Warn ? theme.warn : theme.meta)

export function NoticeSlab(props: { bg: string; cells: number }): React.ReactNode {
  useSyncExternalStore(subscribeNotices, noticeVersion)
  const notice = currentNotice()
  if (notice === null || props.cells < NOTICE_MIN_CELLS) return null

  const text = truncateCells({ text: notice.text, cells: props.cells - SLAB_PAD * 2 })

  return <text fg={inkOf(notice.tone)} bg={props.bg}>{` ${text} `}</text>
}
