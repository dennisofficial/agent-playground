import { toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { EKeyGroup } from '../../ui/keys'
import { App } from '../app'
import {
  fakeApp,
  failingThenStallingModelPort,
  scriptedModelPort,
  type FakeApp,
} from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

const HEADING = EKeyGroup.Composer.toUpperCase()

type Mounted = Awaited<ReturnType<typeof testRender>>

const appWith = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

/**
 * Mock input reaches the renderer through stdin, which resolves on a real tick rather than on the
 * frame — so a bare flush paints before the key has been read.
 */
const READ_MS = 60

async function landed(setup: Mounted): Promise<void> {
  await settle(READ_MS)
  await setup.flush()
}

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(<App app={app} opened={{ threadId: THREAD, events: [], name: null }} />, WIDE)
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

describe('the shortcuts list', () => {
  it('stays out of the way until `?` asks for it', async () => {
    const setup = await opened(appWith())

    try {
      expect(setup.captureCharFrame()).not.toContain(HEADING)

      setup.mockInput.pressKey('?')
      await landed(setup)

      expect(setup.captureCharFrame()).toContain(HEADING)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('closes on escape without interrupting anything', async () => {
    const setup = await opened(appWith())

    try {
      setup.mockInput.pressKey('?')
      await landed(setup)
      expect(setup.captureCharFrame()).toContain(HEADING)

      setup.mockInput.pressEscape()
      await landed(setup)

      expect(setup.captureCharFrame()).not.toContain(HEADING)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('lists a block key only while the block that owns it is on screen', async () => {
    const failing = fakeApp({ model: failingThenStallingModelPort({ message: 'overloaded_error' }) })
    const healthy = await opened(appWith())

    try {
      healthy.mockInput.pressKey('?')
      await landed(healthy)

      expect(healthy.captureCharFrame()).not.toContain('retry a failed turn')
    } finally {
      await teardown(healthy)
    }

    const failed = await opened(failing)

    try {
      await failed.mockInput.typeText('what changed?')
      failed.mockInput.pressEnter()
      await settle(2_000)
      await failed.flush()
      expect(failed.captureCharFrame()).toContain('ctrl+r retry')

      failed.mockInput.pressKey('?')
      await landed(failed)

      expect(failed.captureCharFrame()).toContain('retry a failed turn')
    } finally {
      await teardown(failed)
    }
  }, 60_000)

  it('leaves `?` to the draft once there is something in it', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('why')
      await landed(setup)

      setup.mockInput.pressKey('?')
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).not.toContain(HEADING)
      expect(frame).toContain('why?')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
