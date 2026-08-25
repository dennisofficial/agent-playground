import type { ScrollBoxRenderable } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { MarkdownView } from '../markdown-view'
import { proseSyntaxStyle } from '../syntax-style'
import { measureTable, TABLE_OPTIONS } from '../table-metrics'
import { grammarsReady, teardown } from './harness'

/**
 * `measureTable` predicts the renderer's geometry from the source and the scroll container is sized
 * from that prediction, so a change in OpenTUI's table style has to fail here — against the real
 * renderer — rather than downstream as a table that overlaps its neighbours.
 */

await grammarsReady()

const WIDTH = 60

const WIDE_TABLE = [
  '| Engine | Model | Notes |',
  '| --- | --- | --- |',
  '| claude | opus | a much longer note that pushes this table well past sixty columns |',
  '| codex | gpt | short |',
].join('\n')

const NARROW_TABLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')

function frameLines(frame: string): string[] {
  return frame.split('\n').map((line) => line.replace(/\s+$/, ''))
}

async function mount(source: string) {
  let outer: ScrollBoxRenderable | null = null
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={24}>
      <scrollbox
        flexGrow={1}
        ref={(r: ScrollBoxRenderable | null) => {
          outer = r
        }}
      >
        <box flexDirection="column">
          <text>HEAD MARKER</text>
          <MarkdownView source={source} width={WIDTH - 4} />
          <text>TAIL MARKER</text>
        </box>
      </scrollbox>
    </box>,
    { width: WIDTH, height: 24 },
  )
  await setup.flush()
  return { setup, outer: () => outer as ScrollBoxRenderable | null }
}

describe('measureTable', () => {
  it("predicts the renderer's own geometry", async () => {
    const metrics = measureTable(WIDE_TABLE)
    const setup = await testRender(
      <box flexDirection="column" width={metrics.columns + 2} height={24}>
        <markdown
          content={WIDE_TABLE}
          syntaxStyle={proseSyntaxStyle()}
          tableOptions={TABLE_OPTIONS}
          width={metrics.columns}
        />
      </box>,
      { width: metrics.columns + 2, height: 24 },
    )
    try {
      await setup.flush()
      const drawn = frameLines(setup.captureCharFrame()).filter((line) => line.length > 0)
      expect(drawn.length).toBe(metrics.rows)
      expect(Math.max(...drawn.map((line) => line.length))).toBe(metrics.columns)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('ignores the alignment row and survives escaped pipes', () => {
    expect(measureTable(NARROW_TABLE)).toEqual({ columns: 9, rows: 5 })
    expect(measureTable('| a\\|b |\n| --- |\n| x |').columns).toBe(8)
    expect(measureTable('not a table')).toEqual({ columns: 0, rows: 0 })
  })
})

describe('MarkdownView tables', () => {
  it('keeps the blocks around a wide table intact', async () => {
    const { setup } = await mount(`${WIDE_TABLE}\n\ntail prose`)
    try {
      const lines = frameLines(setup.captureCharFrame())
      const head = lines.findIndex((line) => line.includes('HEAD MARKER'))
      const tail = lines.findIndex((line) => line.includes('TAIL MARKER'))

      expect(head).toBeGreaterThanOrEqual(0)
      expect(tail).toBeGreaterThan(head)
      expect(tail - head - 1).toBeGreaterThanOrEqual(measureTable(WIDE_TABLE).rows)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans a wide table on a horizontal wheel without moving the transcript', async () => {
    const { setup, outer } = await mount(`${WIDE_TABLE}\n\ntail prose`)
    try {
      const before = frameLines(setup.captureCharFrame())
      const row = before.findIndex((line) => line.includes('Engine'))
      const scrollTop = outer()?.scrollTop

      await setup.mockMouse.scroll(10, row, 'right')
      await setup.flush()

      expect(frameLines(setup.captureCharFrame())[row]).not.toBe(before[row])
      expect(outer()?.scrollTop).toBe(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans a wide table on alt+wheel, which its scrollbox knows nothing about', async () => {
    const { setup, outer } = await mount(`${WIDE_TABLE}\n\ntail prose`)
    try {
      const before = frameLines(setup.captureCharFrame())
      const row = before.findIndex((line) => line.includes('Engine'))
      const scrollTop = outer()?.scrollTop

      await setup.mockMouse.scroll(10, row, 'up', { modifiers: { alt: true } })
      await setup.flush()

      expect(frameLines(setup.captureCharFrame())[row]).not.toBe(before[row])
      expect(outer()?.scrollTop).toBe(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('leaves a table that already fits alone', async () => {
    const { setup } = await mount(NARROW_TABLE)
    try {
      const lines = frameLines(setup.captureCharFrame())
      expect(lines.some((line) => line.includes('wheel'))).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it("draws a small table at its own width, not the transcript's", async () => {
    const { setup } = await mount(NARROW_TABLE)
    try {
      const top = frameLines(setup.captureCharFrame()).find((line) => line.includes('┌'))
      expect(top?.trim()).toBe(`┌${'─'.repeat(3)}┬${'─'.repeat(3)}┐`)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('gives every cell a column of air, so the data is not flush against the rules', async () => {
    const { setup } = await mount(NARROW_TABLE)
    try {
      const row = frameLines(setup.captureCharFrame()).find((line) => /│\s*a/.test(line))
      expect(row?.trim()).toBe('│ a │ b │')
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})
