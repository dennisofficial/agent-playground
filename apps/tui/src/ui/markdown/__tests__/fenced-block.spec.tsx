import type { ScrollBoxRenderable } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { CONTENT_PADDING } from '../fenced-block'
import { MarkdownView } from '../markdown-view'
import { grammarsReady, teardown } from './harness'

/**
 * Every claim here is about what the WHEEL does when two scroll containers are nested, which nothing
 * short of a real renderer knows. Coordinates are terminal cells.
 */

await grammarsReady()

const WIDTH = 60
const HEIGHT = 20

const WIDE_FENCE = [
  '```ts',
  `const wide = ${"'x'".repeat(40)};`,
  'const last = 2;',
  '```',
].join('\n')
const FILLER = Array.from({ length: 25 }, (_, i) => `filler line ${i}`).join('\n\n')

function rowOf(frame: string, needle: string): number {
  return frame.split('\n').findIndex((line) => line.includes(needle))
}

/** The code on a fence row, past the left border and the block's padding. */
function codeOf(line: string | undefined): string {
  if (!line) return ''
  const border = line.indexOf('│')
  return border < 0 ? line : line.slice(border + 1 + CONTENT_PADDING)
}

async function mount(source: string) {
  let outer: ScrollBoxRenderable | null = null
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <scrollbox
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        ref={(r: ScrollBoxRenderable | null) => {
          outer = r
        }}
      >
        <box flexDirection="column">
          <MarkdownView source={source} width={WIDTH - 4} />
        </box>
      </scrollbox>
    </box>,
    { width: WIDTH, height: HEIGHT },
  )
  await setup.flush()
  return { setup, outer: () => outer as ScrollBoxRenderable | null }
}

/**
 * `testRender` renders inside `act`, so a `setState` from a hover handler commits only when the event
 * is dispatched inside `act` too — and the committed tree reaches the buffer on the flush after that.
 */
async function hover(
  setup: Awaited<ReturnType<typeof mount>>['setup'],
  x: number,
  y: number,
): Promise<void> {
  await act(async () => {
    await setup.mockMouse.moveTo(x, y)
    await setup.flush()
  })
  await setup.flush()
}

describe('FencedBlock', () => {
  it('keeps a wide fence at its natural width instead of wrapping it', async () => {
    const { setup } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const frame = setup.captureCharFrame()
      expect(rowOf(frame, 'const last = 2;') - rowOf(frame, 'const wide =')).toBe(1)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans the fence sideways on a horizontal wheel, without moving the transcript', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const before = setup.captureCharFrame()
      const codeRow = rowOf(before, 'const wide =')
      const scrollTop = outer()?.scrollTop

      await setup.mockMouse.scroll(10, codeRow, 'right')
      await setup.flush()

      const after = setup.captureCharFrame()
      expect(after.split('\n')[codeRow]).not.toBe(before.split('\n')[codeRow])
      expect(outer()?.scrollTop).toBe(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans one column per report on alt+wheel, the spelling every terminal delivers', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')
      const before = setup.captureCharFrame().split('\n')[codeRow] ?? ''
      const scrollTop = outer()?.scrollTop

      // Zed reports no horizontal wheel and drops shift+scroll, so alt is the only spelling that
      // survives there.
      await setup.mockMouse.scroll(10, codeRow, 'up', { modifiers: { alt: true } })
      await setup.flush()

      const after = setup.captureCharFrame().split('\n')[codeRow] ?? ''
      expect(codeOf(after).slice(0, 19)).toBe(codeOf(before).slice(1, 20))
      expect(outer()?.scrollTop).toBe(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans when its scrollbar is dragged', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const lines = setup.captureCharFrame().split('\n')
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')
      const barRow = lines.findIndex((line, i) => i > codeRow && line.includes('━'))
      const before = lines[codeRow]
      const scrollTop = outer()?.scrollTop

      await setup.mockMouse.drag(3, barRow, 30, barRow)
      await setup.flush()

      expect(setup.captureCharFrame().split('\n')[codeRow]).not.toBe(before)
      expect(outer()?.scrollTop).toBe(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans one column per report, so a swipe scrolls rather than jumps', async () => {
    const { setup } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')
      const textAt = (frame: string): string => codeOf(frame.split('\n')[codeRow])
      const start = textAt(setup.captureCharFrame())

      await setup.mockMouse.scroll(10, codeRow, 'right')
      await setup.flush()

      expect(textAt(setup.captureCharFrame()).slice(0, 20)).toBe(start.slice(1, 21))
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans once, not twice, when shift rides along on a sideways report', async () => {
    const { setup } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')
      const before = setup.captureCharFrame().split('\n')[codeRow] ?? ''

      // macOS turns shift+scroll into a horizontal scroll before the terminal sees it, so on a
      // trackpad both spellings arrive as one left/right report with shift set.
      await setup.mockMouse.scroll(10, codeRow, 'right', { modifiers: { shift: true } })
      await setup.flush()

      const after = setup.captureCharFrame().split('\n')[codeRow] ?? ''
      expect(codeOf(after).slice(0, 19)).toBe(codeOf(before).slice(1, 20))
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('scrolls the transcript on a plain vertical wheel over a fence', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')
      const scrollTop = outer()?.scrollTop ?? 0

      await setup.mockMouse.scroll(10, codeRow, 'up')
      await setup.flush()

      expect(outer()?.scrollTop).toBeLessThan(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('holds the transcript still for the vertical component of a sideways swipe', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')

      await setup.mockMouse.scroll(10, codeRow, 'right')
      await setup.flush()
      const scrollTop = outer()?.scrollTop ?? 0

      await setup.mockMouse.scroll(10, codeRow, 'up')
      await setup.flush()

      expect(outer()?.scrollTop).toBe(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('shrinks a short fence to its content instead of the viewport', async () => {
    const { setup } = await mount(['```ts', 'const x = 1;', '```'].join('\n'))
    try {
      const top = rowOf(setup.captureCharFrame(), '╭')
      await hover(setup, 1, top)

      const lines = setup.captureCharFrame().split('\n')
      const bottom = lines.find((line) => line.includes('╰'))?.replace(/\s+$/, '') ?? ''
      expect(bottom.length).toBeLessThan(WIDTH / 2)
      expect(lines[top]).toContain(' ts ')
      expect(lines[top]).toContain('copy')
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('never shrinks below the header, which would cost it the copy button', async () => {
    const { setup } = await mount(['```ts', 'x', '```'].join('\n'))
    try {
      const row = rowOf(setup.captureCharFrame(), '╭')
      await hover(setup, 1, row)

      const top = setup.captureCharFrame().split('\n')[row] ?? ''
      expect(top).toContain(' ts ')
      expect(top).toContain('copy')
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('leaves the transcript scrolling normally over prose', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const proseRow = rowOf(setup.captureCharFrame(), 'filler line')
      const scrollTop = outer()?.scrollTop ?? 0

      await setup.mockMouse.scroll(10, proseRow >= 0 ? proseRow : 1, 'up')
      await setup.flush()

      expect(outer()?.scrollTop).toBeLessThan(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('falls back to plain text for an unlabelled fence rather than guessing a grammar', async () => {
    const { setup } = await mount('```\nno language here\n```')
    try {
      const lines = setup.captureCharFrame().split('\n')
      expect(lines.some((line) => line.includes('no language here'))).toBe(true)
      // No language in the header, so nothing between the corner and the fill.
      const top = lines.find((line) => line.includes('╭'))
      expect(top).not.toContain(' ts ')
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})
