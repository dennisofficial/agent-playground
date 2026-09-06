import React, { useSyncExternalStore } from 'react'

import { cellsOf } from '../hint-layout'
import {
  currentNotices,
  ENoticePosition,
  noticeVersion,
  subscribeNotices,
} from '../notice-store'
import { NOTICE_MIN_CELLS, toneInk, toneMark } from './notice-stack'
import { truncateCells } from './sidebar/cells'

const SLAB_PAD = 1

export function NoticeSlab(props: { bg: string; cells: number }): React.ReactNode {
  useSyncExternalStore(subscribeNotices, noticeVersion)
  const notices = currentNotices().filter(
    (notice) => notice.position === ENoticePosition.Composer,
  )
  const notice = notices[notices.length - 1]
  if (notice === undefined || props.cells < NOTICE_MIN_CELLS) return null

  const mark = toneMark(notice.tone)
  const room = props.cells - SLAB_PAD * 2 - cellsOf(mark) - 1
  const text = truncateCells({ text: notice.text, cells: room })

  return <text fg={toneInk(notice.tone)} bg={props.bg}>{` ${mark} ${text} `}</text>
}
