import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from './harness'
import { MarkdownView } from '../markdown-view'
import { fenceWidth } from '../fenced-block'

await grammarsReady()

const WIDTH = 80

const fence = (body: string): string => ['```ts', body, '```'].join('\n')

const SHORT = fence('const a = 1;')

const MEDIUM = fence('const somewhatLonger = compute(a, b, c);')

const LONG = fence(`const wide = ${"'x'".repeat(12)};`)

async function slabEdges(source: string): Promise<number[]> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={40}>
      <MarkdownView source={source} width={WIDTH} />
    </box>,
    { width: WIDTH, height: 40 },
  )
  try {
    await setup.flush()
    await settle(250)
    await setup.flush()

    const edges = new Set<number>()
    for (const line of setup.captureSpans().lines) {
      let column = 0
      let last = -1
      for (const span of line.spans) {
        for (const _ of span.text) {
          if (Math.round(span.bg.r * 255) === 0x1e) last = column
          column += 1
        }
      }
      if (last >= 0) edges.add(last)
    }
    return [...edges].sort((a, b) => a - b)
  } finally {
    await teardown(setup)
  }
}

describe('fences in one answer', () => {
  it('share a right edge no matter how wide each one is', async () => {
    const edges = await slabEdges([SHORT, MEDIUM, LONG].join('\n\n'))
    expect(edges).toHaveLength(1)
  }, 60_000)

  it('still hug their content when the answer holds only one', async () => {
    const alone = await slabEdges(SHORT)
    const levelled = await slabEdges([SHORT, LONG].join('\n\n'))
    expect(alone[0]).toBeLessThan(levelled[0] ?? 0)
    expect(levelled[0]).toBe(fenceWidth({ language: 'ts', source: `const wide = ${"'x'".repeat(12)};`, width: WIDTH }) - 1)
  }, 60_000)
})
