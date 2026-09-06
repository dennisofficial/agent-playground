import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import React, { act } from 'react'

import { frameSettled } from '../../__tests__/waiting'
import { MarkdownView } from '../markdown-view'
import { grammarsReady, settle, teardown } from './harness'
import {
  CHUNK_SIZES,
  chunked,
  CORPUS,
  CORPUS_HEIGHT,
  CORPUS_WIDTH,
  styledLines,
} from './streamed-corpus'

/**
 * The streaming path must draw, character for character and style for style, what a one-shot render
 * of the finished message draws. The fixtures were recorded from the pre-incremental pipeline; rerun
 * with RECORD_MARKDOWN_FRAMES=1 only when a deliberate visual change lands.
 */

await grammarsReady()

const FIXTURE = join(import.meta.dir, 'fixtures', 'identical-output.json')

type StreamedFrames = { live: readonly string[]; settled: readonly string[] }

type DocFrames = {
  oneShot: readonly string[]
  streamed: Record<string, StreamedFrames>
}

type Fixture = Record<string, DocFrames>

const recording = process.env.RECORD_MARKDOWN_FRAMES === '1'

const fixture: Fixture = existsSync(FIXTURE)
  ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture)
  : {}

type StreamState = { source: string; streaming: boolean }

let push: ((next: StreamState) => void) | null = null

function Streamed(props: { initial: StreamState }): React.ReactNode {
  const [state, setState] = React.useState<StreamState>(props.initial)
  push = setState
  return (
    <box flexDirection="column" width={CORPUS_WIDTH} height={CORPUS_HEIGHT}>
      <MarkdownView source={state.source} width={CORPUS_WIDTH - 2} streaming={state.streaming} />
    </box>
  )
}

async function mounted(initial: StreamState) {
  const setup = await testRender(<Streamed initial={initial} />, {
    width: CORPUS_WIDTH,
    height: CORPUS_HEIGHT,
  })
  await setup.flush()
  return {
    setup,
    async transition(next: StreamState) {
      await act(async () => void push?.(next))
      await setup.flush()
    },
    async settled(): Promise<readonly string[]> {
      // A settled `<code>` draws plain text at once and its highlight a round trip later, so a
      // steady frame alone can pin the plain one.
      await settle()
      await frameSettled({ setup, within: 3000 })
      return styledLines(setup.captureSpans())
    },
  }
}

async function oneShotFrames(source: string): Promise<readonly string[]> {
  const view = await mounted({ source, streaming: false })
  try {
    return await view.settled()
  } finally {
    await teardown(view.setup)
  }
}

async function streamedFrames(args: { source: string; chunk: number }): Promise<StreamedFrames> {
  const cuts = chunked(args.source, args.chunk)
  const view = await mounted({ source: cuts[0] ?? '', streaming: true })
  try {
    for (const cut of cuts.slice(1)) await view.transition({ source: cut, streaming: true })
    const live = await view.settled()
    await view.transition({ source: args.source, streaming: false })
    const settled = await view.settled()
    return { live, settled }
  } finally {
    await teardown(view.setup)
  }
}

function record(name: string, frames: DocFrames): void {
  fixture[name] = frames
  mkdirSync(dirname(FIXTURE), { recursive: true })
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`)
}

describe('streamed markdown draws what a one-shot render draws', () => {
  for (const [name, source] of Object.entries(CORPUS)) {
    it(`pins ${name}`, async () => {
      const oneShot = await oneShotFrames(source)
      const streamed: Record<string, StreamedFrames> = {}
      for (const chunk of CHUNK_SIZES) {
        streamed[String(chunk)] = await streamedFrames({ source, chunk })
      }

      if (recording) {
        record(name, { oneShot, streamed })
        return
      }

      const expected = fixture[name]
      expect(expected, `no fixture for ${name}; record with RECORD_MARKDOWN_FRAMES=1`).toBeDefined()
      if (expected === undefined) return

      expect(oneShot).toEqual(expected.oneShot)
      for (const chunk of CHUNK_SIZES) {
        const key = String(chunk)
        expect(streamed[key]?.live, `${name} live @${chunk}`).toEqual(expected.streamed[key]?.live)
        expect(streamed[key]?.settled, `${name} settled @${chunk}`).toEqual(
          expected.streamed[key]?.settled,
        )
      }
    }, 120_000)
  }
})
