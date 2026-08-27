import { parseColor, type CapturedFrame, type RGBA } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { grammarsReady, settle, teardown } from '../markdown/__tests__/harness'
import { theme } from '../theme'
import {
  drawn,
  HEIGHT,
  LAST_WORDS,
  SETTLED,
  SendingTranscript,
  SizedTranscript,
} from './transcript-fixture'

await grammarsReady()

const JUMP = 'jump to bottom'

const SHORT = 12

const WIDE = 240

const LONGER_THAN_ONE_FOLLOW_POLL_MS = 400

const pillColour = (frame: CapturedFrame, row: number): RGBA | undefined =>
  frame.lines[row]?.spans.find((span) => span.text.includes(JUMP))?.fg

async function hover(args: {
  setup: {
    mockMouse: { moveTo: (x: number, y: number) => Promise<void> }
    flush: () => Promise<void>
  }
  x: number
  y: number
}): Promise<void> {
  await act(async () => {
    await args.setup.mockMouse.moveTo(args.x, args.y)
    await args.setup.flush()
  })
  await args.setup.flush()
}

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

  it('takes the whole terminal rather than stopping at a fixed column', async () => {
    const setup = await testRender(<SizedTranscript model={SETTLED} />, {
      width: WIDE,
      height: HEIGHT,
    })
    try {
      const rows = (await drawn(setup)).split('\n')
      const rightmost = Math.max(...rows.map((row) => row.replace(/\s+$/, '').length))
      expect(rightmost).toBeGreaterThan(WIDE / 2)
      expect(rightmost).toBeLessThanOrEqual(WIDE)
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

  it('lights the way back up under the pointer, so the pill reads as something to click', async () => {
    const setup = await testRender(<SizedTranscript model={SETTLED} />, {
      width: 80,
      height: SHORT,
    })
    try {
      await drawn(setup)
      for (let wheel = 0; wheel < 6; wheel += 1) await setup.mockMouse.scroll(20, 5, 'up')
      await settle(LONGER_THAN_ONE_FOLLOW_POLL_MS)

      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes(JUMP))
      const column = lines[row]?.indexOf('⌄') ?? -1
      expect(column).toBeGreaterThanOrEqual(0)

      expect(pillColour(setup.captureSpans(), row)?.equals(parseColor(theme.hover))).toBe(true)

      await hover({ setup, x: column, y: row })
      expect(pillColour(setup.captureSpans(), row)?.equals(parseColor(theme.bright))).toBe(true)

      await hover({ setup, x: 1, y: 1 })
      expect(pillColour(setup.captureSpans(), row)?.equals(parseColor(theme.hover))).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('takes what the operator sends back to the newest output', async () => {
    const setup = await testRender(<SendingTranscript model={SETTLED} />, {
      width: 80,
      height: SHORT,
    })
    try {
      await drawn(setup)
      for (let wheel = 0; wheel < 6; wheel += 1) await setup.mockMouse.scroll(20, 5, 'up')
      await settle(LONGER_THAN_ONE_FOLLOW_POLL_MS)
      expect(await drawn(setup)).toContain(JUMP)

      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.flush()
      })
      await settle(LONGER_THAN_ONE_FOLLOW_POLL_MS)

      const landed = await drawn(setup)
      expect(landed).toContain(LAST_WORDS)
      expect(landed).not.toContain(JUMP)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('takes a click on the pill back to the newest output', async () => {
    const setup = await testRender(<SizedTranscript model={SETTLED} />, {
      width: 80,
      height: SHORT,
    })
    try {
      await drawn(setup)
      for (let wheel = 0; wheel < 6; wheel += 1) await setup.mockMouse.scroll(20, 5, 'up')
      await settle(LONGER_THAN_ONE_FOLLOW_POLL_MS)

      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes(JUMP))
      const column = lines[row]?.indexOf('⌄') ?? -1
      expect(column).toBeGreaterThanOrEqual(0)

      await act(async () => {
        await setup.mockMouse.click(column, row)
        await setup.flush()
      })
      await settle(LONGER_THAN_ONE_FOLLOW_POLL_MS)

      const landed = await drawn(setup)
      expect(landed).toContain(LAST_WORDS)
      expect(landed).not.toContain(JUMP)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
