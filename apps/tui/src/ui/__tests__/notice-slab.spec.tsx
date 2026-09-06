import { describe, expect, it } from 'bun:test'
import React from 'react'

import { NoticeSlab } from '../components/notice-slab'
import { dismissNotice, ENoticeTone, notify } from '../notice-store'
import { theme } from '../theme'
import { frameOf } from './transcript-fixture'

const WIDTH = 40

const slab = (cells: number = WIDTH): React.ReactNode => (
  <NoticeSlab bg={theme.appBg} cells={cells} />
)

describe('the notice slab', () => {
  it('takes no room at all while nothing is being said', async () => {
    dismissNotice()
    const frame = await frameOf(slab(), WIDTH)

    expect(frame.trim()).toBe('')
  })

  it('says the thing that happened, marked with its tone', async () => {
    notify({ text: 'copied 3 lines' })
    const frame = await frameOf(slab(), WIDTH)
    dismissNotice()

    expect(frame).toContain('✓ copied 3 lines')
  })

  it('says only the newest when several stand at once', async () => {
    notify({ text: 'first' })
    notify({ text: 'second' })
    const frame = await frameOf(slab(), WIDTH)
    dismissNotice()

    expect(frame).toContain('second')
    expect(frame).not.toContain('first')
  })

  it('marks a warning apart from a confirmation', async () => {
    notify({ text: 'clipboard unavailable', tone: ENoticeTone.Warn })
    const frame = await frameOf(slab(), WIDTH)
    dismissNotice()

    expect(frame).toContain('⚠ clipboard unavailable')
  })

  it('cuts a notice too long for the room it was given rather than wrapping it', async () => {
    notify({ text: 'x'.repeat(WIDTH * 2) })
    const frame = await frameOf(slab(), WIDTH)
    dismissNotice()

    const rows = frame.split('\n').filter((row) => row.includes('x'))
    expect(rows.length).toBe(1)
    expect(frame).toContain('…')
  })

  it('says nothing when the row has no room left to say it in', async () => {
    notify({ text: 'copied 3 lines' })
    const frame = await frameOf(slab(4), WIDTH)
    dismissNotice()

    expect(frame.trim()).toBe('')
  })
})
