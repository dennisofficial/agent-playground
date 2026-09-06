import { describe, expect, it } from 'bun:test'
import React from 'react'

import { NoticeSlab } from '../components/notice-slab'
import { dismissNotice, ENoticePosition, ENoticeTone, notify } from '../notice-store'
import { theme } from '../theme'
import { frameOf } from './transcript-fixture'

const WIDTH = 40

const slab = (cells: number = WIDTH): React.ReactNode => (
  <NoticeSlab bg={theme.appBg} cells={cells} />
)

const onTheEdge = (args: Parameters<typeof notify>[0]): void =>
  notify({ ...args, position: ENoticePosition.Composer })

describe('the notice slab', () => {
  it('takes no room at all while nothing is being said', async () => {
    dismissNotice()
    const frame = await frameOf(slab(), WIDTH)

    expect(frame.trim()).toBe('')
  })

  it('says the thing that happened, unmarked when the words already say it went fine', async () => {
    onTheEdge({ text: 'copied 3 lines' })
    const frame = await frameOf(slab(), WIDTH)
    dismissNotice()

    expect(frame).toContain('copied 3 lines')
    expect(frame).not.toContain('✓')
  })

  it('says only the newest when several stand at once', async () => {
    onTheEdge({ text: 'first' })
    onTheEdge({ text: 'second' })
    const frame = await frameOf(slab(), WIDTH)
    dismissNotice()

    expect(frame).toContain('second')
    expect(frame).not.toContain('first')
  })

  it('leaves notices bound for the tray to the tray', async () => {
    notify({ text: 'a tray notice' })
    const frame = await frameOf(slab(), WIDTH)
    dismissNotice()

    expect(frame.trim()).toBe('')
  })

  it('marks a warning apart from a confirmation', async () => {
    onTheEdge({ text: 'clipboard unavailable', tone: ENoticeTone.Warn })
    const frame = await frameOf(slab(), WIDTH)
    dismissNotice()

    expect(frame).toContain('⚠ clipboard unavailable')
  })

  it('cuts a notice too long for the room it was given rather than wrapping it', async () => {
    onTheEdge({ text: 'x'.repeat(WIDTH * 2) })
    const frame = await frameOf(slab(), WIDTH)
    dismissNotice()

    const rows = frame.split('\n').filter((row) => row.includes('x'))
    expect(rows.length).toBe(1)
    expect(frame).toContain('…')
  })

  it('says nothing when the row has no room left to say it in', async () => {
    onTheEdge({ text: 'copied 3 lines' })
    const frame = await frameOf(slab(4), WIDTH)
    dismissNotice()

    expect(frame.trim()).toBe('')
  })
})
