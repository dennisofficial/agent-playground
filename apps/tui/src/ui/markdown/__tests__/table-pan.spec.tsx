import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { MarkdownView } from '../markdown-view'
import { grammarsReady, teardown } from './harness'

/**
 * A table pans on a scrollbox and a fence pans its own text buffer, for reasons `scroll-highlight`
 * pins. The BAR is shared, and these hold it that way — both that the two blocks draw the same one,
 * and that the drawn one is a `<text>` rather than @opentui 0.4.5's `SliderRenderable`, whose cells
 * survive being scrolled out of an ancestor's viewport and smear across the prose drawn there.
 */

await grammarsReady()

const WIDTH = 40

const HEIGHT = 8

const TABLE = [
  '| Package | Depends on | Owns |',
  '| --- | --- | --- |',
  '| core | zod only | events, ids, assembly |',
].join('\n')

const FENCE = ['```ts', `const wide = ${"'chunk'.concat(".repeat(6)}'end');`, '```'].join('\n')

const TAIL = Array.from({ length: 10 }, (_, index) => `word${index} alpha`).join('\n\n')

const BAR = /[━─]*━[━─]*/

const barsIn = (frame: string): string[] =>
  frame.split('\n').flatMap((row) => BAR.exec(row)?.[0] ?? [])

const thumbStart = (row: string): number => row.indexOf('━')

async function panned(args: {
  setup: {
    mockMouse: {
      scroll: (
        x: number,
        y: number,
        direction: 'up' | 'down' | 'left' | 'right',
        options: { modifiers: { alt: boolean } },
      ) => Promise<void>
    }
    flush: () => Promise<void>
  }
  steps: number
}): Promise<void> {
  for (let step = 0; step < args.steps; step++) {
    await act(async () => {
      await args.setup.mockMouse.scroll(4, 2, 'up', { modifiers: { alt: true } })
      await args.setup.flush()
    })
  }
}

async function mounted(source: string, height = HEIGHT) {
  const setup = await testRender(
    <scrollbox scrollY width={WIDTH} height={height}>
      <MarkdownView source={source} width={WIDTH - 2} />
    </scrollbox>,
    { width: WIDTH, height },
  )
  await setup.flush()
  await new Promise((resolve) => setTimeout(resolve, 600))
  await setup.flush()
  return setup
}

describe('a table wider than the transcript', () => {
  it('pans under alt+wheel and carries the thumb with it', async () => {
    const setup = await mounted(TABLE)
    try {
      expect(thumbStart(barsIn(setup.captureCharFrame())[0] ?? '')).toBe(0)

      await panned({ setup, steps: 10 })

      const frame = setup.captureCharFrame()
      expect(frame).toContain('assembly')
      expect(thumbStart(barsIn(frame)[0] ?? '')).toBeGreaterThan(0)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('takes its bar with it when the transcript scrolls the table away', async () => {
    const setup = await mounted(`${TABLE}\n\n${TAIL}`)
    try {
      expect(barsIn(setup.captureCharFrame()).length).toBe(1)

      for (let step = 0; step < 12; step++) {
        await act(async () => {
          await setup.mockMouse.scroll(2, 6, 'down')
          await setup.flush()
        })
      }

      const frame = setup.captureCharFrame()
      expect(frame).not.toContain('PACKAGE')
      expect(barsIn(frame)).toEqual([])
      expect(frame).not.toContain('█')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('draws the same bar an overflowing fence draws', async () => {
    const setup = await mounted(`${TABLE}\n\n${FENCE}`, 24)
    try {
      const rows = barsIn(setup.captureCharFrame())
      expect(rows.length).toBe(2)
      for (const row of rows) {
        expect(thumbStart(row)).toBe(0)
        expect(row).toContain('─')
      }
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
