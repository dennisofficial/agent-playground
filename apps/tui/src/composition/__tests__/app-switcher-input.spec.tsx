import { refKey, toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

const appWith = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

type Mounted = Awaited<ReturnType<typeof testRender>>

const READ_MS = 60

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(
    <App app={app} opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }} />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

async function landed(setup: Mounted): Promise<void> {
  await settle(READ_MS)
  await setup.flush()
}

async function openSwitcherWith(setup: Mounted): Promise<void> {
  setup.mockInput.pressKey('p', { ctrl: true })
  await landed(setup)
}

async function typed(setup: Mounted, text: string): Promise<void> {
  await setup.mockInput.typeText(text)
  await landed(setup)
}

async function backspace(setup: Mounted): Promise<void> {
  setup.mockInput.pressBackspace()
  await landed(setup)
}

async function arrow(setup: Mounted, direction: 'up' | 'down'): Promise<void> {
  setup.mockInput.pressArrow(direction)
  await landed(setup)
}

async function enter(setup: Mounted): Promise<void> {
  setup.mockInput.pressEnter()
  await landed(setup)
}

async function escape(setup: Mounted): Promise<void> {
  setup.mockInput.pressEscape()
  await landed(setup)
}

describe('the switcher search as a real input', () => {
  it('lands a typed word in the query and narrows the list to it', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await typed(setup, 'opus')

      const frame = setup.captureCharFrame()
      expect(frame).toContain('▸ opus')
      expect(frame).toContain('opus-5')
      expect(frame).not.toContain('sonnet-5')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('edits the query on backspace', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await typed(setup, 'opux')
      expect(setup.captureCharFrame()).toContain('no model by that name')

      await backspace(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('▸ opu')
      expect(frame).toContain('opus-5')
      expect(frame).not.toContain('no model by that name')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('moves the highlight on the arrows while the input holds focus', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await typed(setup, 'claude')
      await arrow(setup, 'up')
      await enter(setup)

      expect(refKey(app.model.choice().ref)).toBe('anthropic/claude-sonnet-5')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('closes on escape after typing, keeping what was answering', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await typed(setup, 'opus')
      await escape(setup)

      expect(refKey(app.model.choice().ref)).toBe('anthropic/claude-haiku-4-5')
      expect(setup.captureCharFrame()).not.toContain('APPLIES')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('lands a pasted word in the query', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await setup.mockInput.pasteBracketedText('opus')
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('▸ opus')
      expect(frame).toContain('opus-5')
      expect(frame).not.toContain('sonnet-5')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
