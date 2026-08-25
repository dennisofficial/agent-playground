import { parseColor, type CapturedFrame, type RGBA } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { theme } from '../../theme'
import { MarkdownView } from '../markdown-view'
import { grammarsReady, teardown } from './harness'

/**
 * The claim under test is that the button is REACHABLE — that a `<text>` nested several boxes deep
 * inside a scrolling transcript receives a mouse press at its own coordinates. The label is the only
 * evidence a reader gets that a copy happened, so the label is what this asserts on.
 */

await grammarsReady()

const FENCE = ['```ts', 'const answer = 42;', '```'].join('\n')

function labelColour(frame: CapturedFrame, row: number): RGBA | undefined {
  return frame.lines[row]?.spans.find((span) => span.text.includes('copy'))?.fg
}

/**
 * `testRender` renders inside `act`, so a `setState` from a hover handler commits only when the event
 * is dispatched inside `act` too — and the committed tree reaches the buffer on the flush after that.
 */
async function hover(
  setup: {
    mockMouse: { moveTo: (x: number, y: number) => Promise<void> }
    flush: () => Promise<void>
  },
  x: number,
  y: number,
): Promise<void> {
  await act(async () => {
    await setup.mockMouse.moveTo(x, y)
    await setup.flush()
  })
  await setup.flush()
}

function mount(args: { scrolling: boolean }) {
  const view = <MarkdownView source={FENCE} width={56} />
  return testRender(
    <box flexDirection="column" width={60} height={12}>
      {args.scrolling ? (
        <scrollbox flexGrow={1}>
          <box flexDirection="column">{view}</box>
        </scrollbox>
      ) : (
        view
      )}
    </box>,
    { width: 60, height: 12 },
  )
}

describe('CopyButton', () => {
  it('copies the block on a click, and says so', async () => {
    const setup = await mount({ scrolling: true })
    try {
      await setup.flush()
      const border = setup
        .captureCharFrame()
        .split('\n')
        .findIndex((line) => line.includes('╭'))
      await hover(setup, setup.captureCharFrame().split('\n')[border]?.indexOf('╭') ?? 0, border)

      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes('copy'))
      expect(row).toBe(border)

      // On the fence's top border, opposite the language — not on a row of its own.
      expect(lines[row]).toContain('╭')
      expect(lines[row]).toContain(' ts ')

      const column = lines[row]?.indexOf('⧉') ?? -1
      expect(column).toBeGreaterThanOrEqual(0)

      await setup.mockMouse.click(column, row)
      await setup.flush()

      // OSC 52 is unsupported in the in-memory test terminal and `pbcopy` is not reached from a
      // test, so the honest outcome is the refusal label — the button reports what happened rather
      // than always claiming success.
      const after = setup.captureCharFrame().split('\n')
      expect(after[row]?.includes('copied') || after[row]?.includes('blocked')).toBe(true)
      expect(after[row]?.replace(/\s+$/, '').length).toBe(lines[row]?.replace(/\s+$/, '').length)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('brightens under the pointer and settles back when it leaves', async () => {
    const setup = await mount({ scrolling: false })
    try {
      await setup.flush()
      const border = setup
        .captureCharFrame()
        .split('\n')
        .findIndex((line) => line.includes('╭'))
      await hover(setup, 1, border)

      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes('copy'))
      const column = lines[row]?.indexOf('⧉') ?? -1
      expect(column).toBeGreaterThanOrEqual(0)

      expect(lines[row]?.trimEnd().endsWith('copy ─╮')).toBe(true)

      const resting = labelColour(setup.captureSpans(), row)
      expect(resting?.equals(parseColor(theme.dim))).toBe(true)

      await hover(setup, column, row)
      expect(labelColour(setup.captureSpans(), row)?.equals(parseColor(theme.hover))).toBe(true)

      // Off the button but still on the same border line: the brightening tracks the button, not
      // the row, or every fence would light up whenever the pointer crossed it.
      await hover(setup, 2, row)
      expect(labelColour(setup.captureSpans(), row)?.equals(parseColor(theme.dim))).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('stays out of the border until the pointer is somewhere in the block', async () => {
    const setup = await mount({ scrolling: false })
    try {
      await setup.flush()
      const resting = setup.captureCharFrame().split('\n')
      const border = resting.findIndex((line) => line.includes('╭'))
      expect(resting[border]).not.toContain('copy')
      expect(resting[border]).toContain(' ts ')

      // The CODE, not the header: the whole block is the hover target.
      const code = resting.findIndex((line) => line.includes('const answer'))
      await hover(setup, 4, code)
      const shown = setup.captureCharFrame().split('\n')
      expect(shown[border]).toContain('copy')
      expect(shown[border]?.trimEnd().length).toBe(resting[border]?.trimEnd().length)

      await hover(setup, 40, 11)
      expect(setup.captureCharFrame().split('\n')[border]).not.toContain('copy')
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('holds its report on screen after the pointer has left the block', async () => {
    const setup = await mount({ scrolling: false })
    try {
      await setup.flush()
      const border = setup
        .captureCharFrame()
        .split('\n')
        .findIndex((line) => line.includes('╭'))
      await hover(setup, 1, border)
      const column = setup.captureCharFrame().split('\n')[border]?.indexOf('⧉') ?? -1

      await setup.mockMouse.click(column, border)
      await setup.flush()

      // Copying is often the last thing done in a block, so the pointer leaves right after the
      // click. Hiding the button on the way out would swallow the only report the click makes.
      await hover(setup, 40, 11)
      const after = setup.captureCharFrame().split('\n')[border]
      expect(after?.includes('copied') || after?.includes('blocked')).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})
