import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { glyph } from '../../theme'
import { MarkdownView } from '../markdown-view'
import { grammarsReady, teardown } from './harness'

/**
 * The caret is a claim about a ROW, so it is tested against drawn rows.
 *
 * A caret rendered beside `<markdown>` rather than inside it looks correct in a component tree and
 * wrong on screen: it becomes its own flex child and lands on the line below the text it is meant to
 * be trailing. Nothing short of reading the frame catches that.
 */

await grammarsReady()

const WIDTH = 60

const FENCE = ['```ts', 'const x = 1;', '```'].join('\n')

async function frame(args: { source: string; streaming: boolean }): Promise<string[]> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={24}>
      <MarkdownView source={args.source} width={WIDTH - 4} streaming={args.streaming} />
    </box>,
    { width: WIDTH, height: 24 },
  )
  try {
    await setup.flush()
    return setup
      .captureCharFrame()
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
  } finally {
    await teardown(setup)
  }
}

describe('streaming caret', () => {
  it('sits on the same row as the last word', async () => {
    const lines = await frame({ source: 'Draining the queue', streaming: true })
    const row = lines.find((line) => line.includes('Draining the queue'))

    expect(row).toContain(`queue${glyph.caret}`)
    // And nowhere else: a stray second caret would mean the sibling render came back.
    expect(lines.filter((line) => line.includes(glyph.caret))).toHaveLength(1)
  }, 30_000)

  it('holds against the last word instead of following a trailing newline', async () => {
    // The shape a model actually emits: the paragraph break arrives before the next word does.
    const lines = await frame({ source: 'Draining the queue.\n\n', streaming: true })
    const row = lines.findIndex((line) => line.includes(glyph.caret))

    expect(lines[row]).toContain(`queue.${glyph.caret}`)
  }, 30_000)

  it('stays out of the text once the block is committed', async () => {
    const lines = await frame({ source: 'Draining the queue', streaming: false })

    expect(lines.some((line) => line.includes(glyph.caret))).toBe(false)
  }, 30_000)

  it('falls to the line below a fence, which owns its own last row', async () => {
    const lines = await frame({ source: `Here:\n\n${FENCE}`, streaming: true })
    const caret = lines.findIndex((line) => line.includes(glyph.caret))
    const code = lines.findIndex((line) => line.includes('const x = 1;'))

    // Inside the fence it would read as a line of code; below it, it reads as what comes next.
    expect(code).toBeGreaterThanOrEqual(0)
    expect(caret).toBeGreaterThan(code)
    expect(lines[caret]?.trim()).toBe(glyph.caret)
  }, 30_000)

  it('keeps the caret out of a table, which would lex it as a fourth column', async () => {
    const table = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const lines = await frame({ source: table, streaming: true })
    const caret = lines.findIndex((line) => line.includes(glyph.caret))
    const lastRow = lines.findIndex((line) => line.includes('│ 1 │'))

    expect(lastRow).toBeGreaterThanOrEqual(0)
    expect(caret).toBeGreaterThan(lastRow)
  }, 30_000)
})
