import { testRender } from '@opentui/react/test-utils'
import { describe, it } from 'bun:test'
import React, { act } from 'react'

import { MarkdownView } from '../markdown-view'
import { sourcedProseBlocks } from '../prose/blocks'
import { growingProseBlocks } from '../prose/growing-blocks'
import { growingSegments, steadySegments } from '../segment'
import { grammarsReady, teardown } from './harness'
import { chunked } from './streamed-corpus'

/**
 * Not a test: a bench of what the markdown pipeline spends while a fence-less reply streams in.
 * Run with MARKDOWN_BENCH=1 to print the numbers; it is skipped otherwise.
 */

const benching = process.env.MARKDOWN_BENCH === '1'

const CHUNK = 20

const REPLY = Array.from({ length: 12 }, (_, section) =>
  [
    `## Section ${section + 1}: what changed and why it matters`,
    '',
    `The worker drifted past its quota while the queue kept growing, so paragraph ${section + 1} walks through the fix in enough words to wrap several times at any sane width, with \`inline code\`, **bold**, *italic* and a [link](https://example.com/${section}).`,
    '',
    '- The fast path, which never touches disk and returns the cached answer.',
    '- The slow path, which does, and is the one that showed up in the profile.',
    '- The mixed path, which tries the first and falls back to the second.',
    '',
    `> A quoted aside for section ${section + 1} that also wraps onto a second row.`,
    '',
    'A closing paragraph rounds the section off with a sentence that is long enough to matter.',
  ].join('\n'),
).join('\n\n')

function parseMsPerChunk(parse: (source: string) => unknown): {
  total: number
  last: number
  segmenting: number
} {
  let total = 0
  let last = 0
  let segmenting = 0
  for (const cut of chunked(REPLY, CHUNK)) {
    const started = performance.now()
    const segments = steadySegments({ segments: growingSegments({ source: cut }) })
    segmenting += performance.now() - started
    const parsing = performance.now()
    for (const segment of segments) if (segment.kind === 'prose') parse(segment.text)
    last = performance.now() - parsing
    total += last
  }
  return { total, last, segmenting }
}

describe.skipIf(!benching)('streaming prose bench', () => {
  it(`reports parse time for a ${REPLY.length} byte reply in ${CHUNK} char chunks`, () => {
    parseMsPerChunk(sourcedProseBlocks)
    const oneShot = parseMsPerChunk(sourcedProseBlocks)
    const growing = parseMsPerChunk(growingProseBlocks)
    console.log(
      `[bench] one-shot parse per chunk: total ${oneShot.total.toFixed(1)} ms, last chunk ${oneShot.last.toFixed(2)} ms`,
    )
    console.log(
      `[bench] growing parse per chunk:  total ${growing.total.toFixed(1)} ms, last chunk ${growing.last.toFixed(2)} ms`,
    )
    console.log(`[bench] segmenting (growingSegments + steadySegments): ${growing.segmenting.toFixed(1)} ms`)
  })

  it('reports end-to-end MarkdownView time per chunk', async () => {
    await grammarsReady()
    let push: ((source: string) => void) | null = null
    function Streamed(): React.ReactNode {
      const [source, setSource] = React.useState('')
      push = setSource
      return (
        <box flexDirection="column" width={80} height={40}>
          <MarkdownView source={source} width={78} streaming />
        </box>
      )
    }
    const setup = await testRender(<Streamed />, { width: 80, height: 40 })
    try {
      await setup.flush()
      let reacting = 0
      let flushing = 0
      for (const cut of chunked(REPLY, CHUNK)) {
        const pushed = performance.now()
        await act(async () => void push?.(cut))
        reacting += performance.now() - pushed
        const flushed = performance.now()
        await setup.flush()
        flushing += performance.now() - flushed
      }
      console.log(
        `[bench] MarkdownView over ${chunked(REPLY, CHUNK).length} chunks: react render+commit ${reacting.toFixed(0)} ms, test renderer flush ${flushing.toFixed(0)} ms`,
      )
    } finally {
      await teardown(setup)
    }
  }, 120_000)
})
