import { describe, expect, it } from 'bun:test'
import React from 'react'

import { NoticeLine } from '../components/notice-line'
import { dismissNotice, ENoticeTone, notify } from '../notice-store'
import { frameOf } from './transcript-fixture'

const WIDTH = 40

describe('the notice line', () => {
  it('keeps its row whether or not anything is being said', async () => {
    dismissNotice()
    const frame = await frameOf(<NoticeLine width={WIDTH} />, WIDTH)

    expect(frame.split('\n')[0]?.trim()).toBe('')
  })

  it('says the last thing that happened', async () => {
    notify({ text: 'copied 3 lines' })
    const frame = await frameOf(<NoticeLine width={WIDTH} />, WIDTH)
    dismissNotice()

    expect(frame).toContain('copied 3 lines')
  })

  it('marks a warning apart from a confirmation', async () => {
    notify({ text: 'clipboard unavailable', tone: ENoticeTone.Warn })
    const frame = await frameOf(<NoticeLine width={WIDTH} />, WIDTH)
    dismissNotice()

    expect(frame).toContain('clipboard unavailable')
  })

  it('cuts a notice too long for the row rather than wrapping it', async () => {
    notify({ text: 'x'.repeat(WIDTH * 2) })
    const frame = await frameOf(<NoticeLine width={WIDTH} />, WIDTH)
    dismissNotice()

    const rows = frame.split('\n').filter((row) => row.includes('x'))
    expect(rows.length).toBe(1)
    expect(frame).toContain('…')
  })
})
