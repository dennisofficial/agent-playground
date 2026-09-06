import { describe, expect, it } from 'bun:test'
import React from 'react'

import { NoticeStack } from '../components/notice-stack'
import {
  clearNotice,
  currentNotices,
  dismissNotice,
  ENoticePosition,
  ENoticeTone,
  notify,
  tickNotices,
} from '../notice-store'
import { frameOf } from './transcript-fixture'

const WIDTH = 40

const stack = (width: number = WIDTH): React.ReactNode => <NoticeStack width={width} />

describe('the notice stack', () => {
  it('takes no room at all while nothing is being said', async () => {
    dismissNotice()
    const frame = await frameOf(stack(), WIDTH)

    expect(frame.trim()).toBe('')
  })

  it('keeps its own row between the transcript and the composer', async () => {
    dismissNotice()
    notify({ text: 'copied 3 lines' })
    const frame = await frameOf(
      <box flexDirection="column" height={4}>
        <text>transcript</text>
        {stack()}
        <text>composer</text>
      </box>,
      WIDTH,
    )
    dismissNotice()

    const rows = frame.split('\n')
    const transcript = rows.findIndex((row) => row.includes('transcript'))
    const notice = rows.findIndex((row) => row.includes('copied 3 lines'))
    const composer = rows.findIndex((row) => row.includes('composer'))
    expect(notice).toBe(transcript + 1)
    expect(composer).toBe(notice + 1)
  })

  it('says the thing that happened', async () => {
    notify({ text: 'copied 3 lines' })
    const frame = await frameOf(stack(), WIDTH)
    dismissNotice()

    expect(frame).toContain('✓ copied 3 lines')
  })

  it('hugs the left edge of the row it is given', async () => {
    notify({ text: 'copied 3 lines' })
    const frame = await frameOf(stack(), WIDTH)
    dismissNotice()

    const row = frame.split('\n').find((line) => line.includes('copied'))
    expect(row?.indexOf('✓')).toBe(1)
  })

  it('marks a warning apart from a confirmation', async () => {
    notify({ text: 'clipboard unavailable', tone: ENoticeTone.Warn })
    const frame = await frameOf(stack(), WIDTH)
    dismissNotice()

    expect(frame).toContain('⚠ clipboard unavailable')
  })

  it('cuts a notice too long for the room it was given rather than wrapping it', async () => {
    notify({ text: 'x'.repeat(WIDTH * 2) })
    const frame = await frameOf(stack(), WIDTH)
    dismissNotice()

    const rows = frame.split('\n').filter((row) => row.includes('x'))
    expect(rows.length).toBe(1)
    expect(frame).toContain('…')
  })

  it('stacks what lands together, the newest closest to the composer', async () => {
    notify({ text: 'first' })
    notify({ text: 'second' })
    const frame = await frameOf(stack(), WIDTH)
    dismissNotice()

    const rows = frame.split('\n')
    const firstRow = rows.findIndex((row) => row.includes('first'))
    const secondRow = rows.findIndex((row) => row.includes('second'))
    expect(firstRow).toBeGreaterThanOrEqual(0)
    expect(secondRow).toBeGreaterThan(firstRow)
  })

  it('leaves notices bound for the composer edge to the edge', async () => {
    notify({ text: 'copied 3 lines', position: ENoticePosition.Composer })
    const frame = await frameOf(stack(), WIDTH)
    dismissNotice()

    expect(frame.trim()).toBe('')
  })

  it('says nothing when the room is too narrow to say it in', async () => {
    notify({ text: 'copied 3 lines' })
    const frame = await frameOf(stack(4), WIDTH)
    dismissNotice()

    expect(frame.trim()).toBe('')
  })
})

describe('the notice store', () => {
  it('replaces a reposted key rather than stacking a twin', () => {
    dismissNotice()
    notify({ key: 'copy', text: 'copied' })
    notify({ key: 'copy', text: 'copied 2 lines' })

    expect(currentNotices()).toHaveLength(1)
    expect(currentNotices()[0]?.text).toBe('copied 2 lines')
    dismissNotice()
  })

  it('drops an expired notice on the tick and keeps one still living', () => {
    dismissNotice()
    const now = Date.now()
    notify({ key: 'gone', text: 'gone', ttlMs: 10 })
    notify({ key: 'staying', text: 'staying', ttlMs: 60_000 })

    tickNotices({ nowMs: now + 20 })

    expect(currentNotices().map((notice) => notice.key)).toEqual(['staying'])
    dismissNotice()
  })

  it('holds a sticky notice until the condition that raised it clears it', () => {
    dismissNotice()
    notify({ key: 'offline', text: 'nudge offline', tone: ENoticeTone.Warn, sticky: true })

    tickNotices({ nowMs: Date.now() + 3_600_000 })
    expect(currentNotices().map((notice) => notice.key)).toEqual(['offline'])

    clearNotice({ key: 'offline' })
    expect(currentNotices()).toHaveLength(0)
  })
})
