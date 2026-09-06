import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { Profiler } from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { frameSettled } from '../../ui/__tests__/waiting'
import { App } from '../app'
import { spokenIn, THREAD, until } from './app-fixture'
import { fakeApp, scriptedModelPort } from './fake-app'

await grammarsReady()

const WIDTH = 90

const HEIGHT = 30

const CHUNKS = 12

const CHUNK_TEXT = 'word '

const DRAIN_MS = 400

const NOTHING_ON_THE_CLIPBOARD = async () => null

describe('a burst of model chunks inside one paced frame', () => {
  it('commits the app with the frame, not once per chunk', async () => {
    const app = fakeApp({ model: scriptedModelPort({ script: { thinking: '', reply: 'ok' } }) })
    const opened = await spokenIn(app)
    let commits = 0

    const setup = await testRender(
      <Profiler
        id="app"
        onRender={() => {
          commits += 1
        }}
      >
        <App app={app} opened={opened} clipboard={NOTHING_ON_THE_CLIPBOARD} />
      </Profiler>,
      { width: WIDTH, height: HEIGHT },
    )

    try {
      const publisher = app.channel.publisherFor({ threadId: THREAD })
      publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'opening ' })
      await frameSettled({ setup })
      const settledBefore = await until({
        holds: async () => (await frame(setup)).includes('opening'),
        within: 5_000,
      })
      expect(settledBefore).toBe(true)
      await settle(DRAIN_MS)
      await setup.flush()

      commits = 0
      for (let index = 0; index < CHUNKS; index += 1) {
        publisher.onChunk({ type: 'text-delta', id: 'b1', text: CHUNK_TEXT })
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
      }
      const beforeFrame = commits

      await settle(DRAIN_MS)
      await setup.flush()
      const afterDrain = commits

      expect(beforeFrame).toBeLessThanOrEqual(1)
      expect(afterDrain).toBeGreaterThanOrEqual(1)

      const painted = await frame(setup)
      expect(painted).toContain('word word word')
      expect(painted).toContain(`↓ ${Math.ceil(('opening '.length + CHUNK_TEXT.length * CHUNKS) / 4)} tokens`)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

async function frame(setup: { flush: () => Promise<void>; captureCharFrame: () => string }) {
  await setup.flush()
  return setup.captureCharFrame()
}
