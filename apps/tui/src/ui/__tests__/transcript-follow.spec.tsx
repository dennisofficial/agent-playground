import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../markdown/__tests__/harness'
import { READING_COLUMN } from '../reading-column'
import { drawn, HEIGHT, LAST_WORDS, SETTLED, SizedTranscript } from './transcript-fixture'

await grammarsReady()

const JUMP = 'jump to bottom'

const SHORT = 12

const LONGER_THAN_ONE_FOLLOW_POLL_MS = 400

describe('the transcript reflows', () => {
  it('survives being resized under a mounted transcript', async () => {
    const setup = await testRender(<SizedTranscript model={SETTLED} />, {
      width: 120,
      height: HEIGHT,
    })
    try {
      const wide = await drawn(setup)
      expect(wide).toContain(LAST_WORDS)

      setup.resize(48, HEIGHT)
      const narrow = await drawn(setup)

      expect(narrow).not.toBe(wide)
      expect(narrow).toContain('Plain text entry, nothing')
      for (const row of narrow.split('\n')) expect(row.length).toBeLessThanOrEqual(48)

      setup.resize(120, HEIGHT)
      expect(await drawn(setup)).toContain(LAST_WORDS)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('holds the reply inside a reading column on a very wide terminal', async () => {
    const setup = await testRender(<SizedTranscript model={SETTLED} />, {
      width: 240,
      height: HEIGHT,
    })
    try {
      const rows = (await drawn(setup)).split('\n')
      const rightmost = Math.max(...rows.map((row) => row.replace(/\s+$/, '').length))
      expect(rightmost).toBeGreaterThan(READING_COLUMN / 2)
      expect(rightmost).toBeLessThanOrEqual(READING_COLUMN)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('the transcript follows the newest output', () => {
  it('sits at the bottom with nothing offering a way down', async () => {
    const setup = await testRender(<SizedTranscript model={SETTLED} />, {
      width: 80,
      height: SHORT,
    })
    try {
      const frame = await drawn(setup)
      expect(frame).toContain(LAST_WORDS)
      expect(frame).not.toContain(JUMP)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stops following the moment the operator scrolls up, and says how to get back', async () => {
    const setup = await testRender(<SizedTranscript model={SETTLED} />, {
      width: 80,
      height: SHORT,
    })
    try {
      await drawn(setup)
      for (let wheel = 0; wheel < 6; wheel += 1) await setup.mockMouse.scroll(20, 5, 'up')
      await settle(LONGER_THAN_ONE_FOLLOW_POLL_MS)
      const scrolled = await drawn(setup)

      expect(scrolled).not.toContain(LAST_WORDS)
      expect(scrolled).toContain(JUMP)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
