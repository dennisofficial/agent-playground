import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { CONTENT_PADDING, gutterWidth } from '../fenced-block'
import { MarkdownView } from '../markdown-view'
import { grammarsReady, teardown } from './harness'

/**
 * Highlighting has to survive PANNING, which is a claim about colours and therefore needs a real
 * renderer, a real grammar and the captured cell colours — a char frame would pass happily while the
 * block was unreadable.
 *
 * The bug this pins: OpenTUI draws a CLIPPED styled text buffer with its text shifted and its styles
 * left where they were, so a fence drawn at its natural width inside a scrollbox showed, from about
 * column seven onwards, every character wearing the colour of one several columns to its left.
 * Measured on 0.4.5; the fix is `TextPanner`, which never clips.
 */

await grammarsReady()

const HEIGHT = 12
const LINE = `export const wide: string = ${"'chunk'.concat(".repeat(12)}'end');`
const FENCE = ['```ts', LINE, '```'].join('\n')

const CELLS_BEFORE_CODE = 1 + CONTENT_PADDING + gutterWidth(LINE)

const CELLS_AFTER_CODE = 8

type Spans = {
  lines: { spans: { text: string; fg?: { buffer?: Record<number, number> } }[] }[]
}

function fenceRow(setup: { captureCharFrame: () => string }): number {
  return setup
    .captureCharFrame()
    .split('\n')
    .findIndex((line) => /export|chunk|concat/.test(line))
}

function colouredCellsOfFenceRow(setup: {
  captureSpans: () => unknown
  captureCharFrame: () => string
}): string[] {
  const row = fenceRow(setup)
  const out: string[] = []
  for (const span of (setup.captureSpans() as Spans).lines[row]?.spans ?? []) {
    const fg = span.fg?.buffer ?? {}
    const colour = [0, 1, 2].map((i) => Math.round((fg[i] ?? 0) * 255)).join(',')
    for (const char of [...span.text]) out.push(`${colour}:${char}`)
  }
  return out
}

async function pannedTo(args: { width: number; offset: number }): Promise<string[]> {
  const setup = await testRender(
    <box flexDirection="column" width={args.width} height={HEIGHT}>
      <MarkdownView source={FENCE} width={args.width - 4} />
    </box>,
    { width: args.width, height: HEIGHT },
  )
  try {
    await setup.flush()
    // Highlighting is a round trip to the tree-sitter worker and nothing in the frame says it
    // landed, so this waits for it rather than racing it.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await setup.flush()

    const row = fenceRow(setup)
    for (let i = 0; i < args.offset; i++) {
      await setup.mockMouse.scroll(CELLS_BEFORE_CODE + 2, row, 'right')
    }
    await setup.flush()
    return colouredCellsOfFenceRow(setup)
  } finally {
    await teardown(setup)
  }
}

describe('a panned fence', () => {
  it('paints every character the colour it has when the block is drawn whole', async () => {
    const whole = await pannedTo({ width: 260, offset: 0 })
    expect(new Set(whole.map((cell) => cell.split(':')[0])).size).toBeGreaterThan(3)

    for (const offset of [1, 7, 13, 40]) {
      const panned = await pannedTo({ width: 60, offset })
      const shown = panned.slice(CELLS_BEFORE_CODE, panned.length - CELLS_AFTER_CODE)
      const expected = whole.slice(
        CELLS_BEFORE_CODE + offset,
        CELLS_BEFORE_CODE + offset + shown.length,
      )
      expect({ offset, shown }).toEqual({ offset, shown: expected })
    }
  }, 120_000)
})
