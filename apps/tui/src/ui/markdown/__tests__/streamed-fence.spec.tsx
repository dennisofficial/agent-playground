import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { MarkdownView } from '../markdown-view'
import { grammarsReady, settle, teardown } from './harness'

/**
 * A fence that streamed keeps its styled buffer when it stops being the live tail. The claim is
 * about colours the moment after the transition — before the next highlight round trip can land —
 * so a char frame cannot see it and a settle would hide it.
 */

await grammarsReady()

const WIDTH = 60
const HEIGHT = 16

const FENCE = ['```ts', 'const answer: number = 42;', '```'].join('\n')

type StreamState = { source: string; streaming: boolean }

let push: ((next: StreamState) => void) | null = null

function Streamed(props: { initial: string }): React.ReactNode {
  const [state, setState] = React.useState<StreamState>({
    source: props.initial,
    streaming: true,
  })
  push = setState
  return (
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <MarkdownView source={state.source} width={WIDTH - 4} streaming={state.streaming} />
    </box>
  )
}

type Spans = {
  lines: { spans: { text: string; fg?: { buffer?: Record<number, number> } }[] }[]
}

function codeRow(setup: { captureCharFrame: () => string }): number {
  return setup
    .captureCharFrame()
    .split('\n')
    .findIndex((line) => line.includes('answer'))
}

function codeRowColours(setup: {
  captureSpans: () => unknown
  captureCharFrame: () => string
}): string[] {
  const row = codeRow(setup)
  const out: string[] = []
  for (const span of (setup.captureSpans() as Spans).lines[row]?.spans ?? []) {
    const fg = span.fg?.buffer ?? {}
    const colour = [0, 1, 2].map((i) => Math.round((fg[i] ?? 0) * 255)).join(',')
    for (const char of [...span.text]) out.push(`${colour}:${char}`)
  }
  return out
}

async function mounted(initial: string) {
  const setup = await testRender(<Streamed initial={initial} />, {
    width: WIDTH,
    height: HEIGHT,
  })
  await setup.flush()
  await settle()
  return {
    setup,
    async transition(next: StreamState) {
      await act(async () => void push?.(next))
      // One render pass, never a settle: the claim is what the FIRST frame after the
      // transition holds, and waiting for visual idle lets the replacement highlight land
      // and paper over a plain-text frame.
      await setup.renderOnce()
    },
  }
}

describe('a fence that streamed', () => {
  it('keeps its highlight while more of its own body arrives', async () => {
    const view = await mounted('```ts\nconst answer: number = 4\n')
    try {
      const before = codeRowColours(view.setup)
      expect(new Set(before.map((cell) => cell.split(':')[0])).size).toBeGreaterThan(2)

      await view.transition({
        source: '```ts\nconst answer: number = 42;\n',
        streaming: true,
      })
      // The buffer holds either the old highlight or the new one; what it may never hold is
      // plain text, which wears a single colour.
      const after = new Set(codeRowColours(view.setup).map((cell) => cell.split(':')[0]))
      expect(after.size).toBeGreaterThan(2)
    } finally {
      await teardown(view.setup)
    }
  }, 30_000)

  it('keeps its highlight when prose streams in behind it', async () => {
    const view = await mounted(FENCE)
    try {
      const before = codeRowColours(view.setup)
      expect(new Set(before.map((cell) => cell.split(':')[0])).size).toBeGreaterThan(2)

      await view.transition({ source: `${FENCE}\n\nclosing prose`, streaming: true })
      expect(codeRowColours(view.setup)).toEqual(before)
    } finally {
      await teardown(view.setup)
    }
  }, 30_000)

  it('keeps its highlight when the stream ends', async () => {
    const view = await mounted(FENCE)
    try {
      const before = codeRowColours(view.setup)
      expect(new Set(before.map((cell) => cell.split(':')[0])).size).toBeGreaterThan(2)

      await view.transition({ source: FENCE, streaming: false })
      expect(codeRowColours(view.setup)).toEqual(before)
    } finally {
      await teardown(view.setup)
    }
  }, 30_000)
})
